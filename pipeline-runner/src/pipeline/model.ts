// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
/**
 * Pipeline Model - v12 Migration
 *
 * Replaces DynamoDB operations with GraphQL v12 + SQLite merge accumulator:
 * - Task mapping → WorkflowRevisionNodeStates via GraphQL
 * - Pending tasks → PipelineMergeAccumulator via SQLite
 * - Atomic merge operations → SQLite transactions
 */

import { LRUCache } from 'lru-cache'
import {
  type AssetId,
  CompoundAssetReference,
  type DictLazyAsset,
  type LazyAsset,
  toAssetId,
  type TraceId,
  type ValueOrRef,
} from 'playtiss'
import { load, store, toReference } from 'playtiss/asset-store'
import { type Node, type Pipeline } from 'playtiss/pipeline'
import { jsonify } from 'playtiss/types/json'

import { PipelineGraphQLClient } from '../graphql/pipeline.js'
import { getLimiter } from '../utils/concurrency-limiter.js'

// ================================================================
// V12 TYPES
// ================================================================
import type { Task } from '../graphql/types.js'

/**
 * V12 Context - no longer includes "%id" since workflow task info is passed separately
 */
export type V12Context = Record<string, LazyAsset>

/**
 * V12 Workflow Execution Context - passed to all model functions
 * Contains all workflow-related references including worker identity
 */
export interface V12WorkflowExecutionContext {
  workflowTaskId: TraceId // The workflow instance task ID
  workflowRevisionId: TraceId // The workflow revision/version ID
  workerId: string // The worker ID that claimed this workflow task
}

// ================================================================
// V12 CONTEXT HANDLING
// ================================================================

/**
 * V12 Context Refactor Complete:
 * - No longer extract workflow info from Context.%id
 * - Pass V12WorkflowExecutionContext as separate parameter
 * - Store V12Context directly without %id field
 */

// ================================================================
// V12 HELPER FUNCTIONS
// ================================================================

// Shared GraphQL client instance for reuse across model operations
let sharedGraphQLClient: PipelineGraphQLClient | null = null

/**
 * Get or create shared GraphQL client instance
 * Reuses the same client to take advantage of Apollo Client caching
 */
export function getSharedGraphQLClient(): PipelineGraphQLClient {
  if (!sharedGraphQLClient) {
    sharedGraphQLClient = new PipelineGraphQLClient()
  }
  return sharedGraphQLClient
}

// ================================================================
// CONTEXT ASSET HASH CACHING
// ================================================================

/**
 * Cache for context asset hash computation to avoid redundant S3 store() calls
 *
 * Context is typically {} (empty object) for most workflows, leading to massive
 * S3 request duplication. This cache eliminates the bottleneck.
 *
 * Key: JSON.stringify(jsonify(context)) - stable representation that handles:
 *   - CompoundAssetReferences (converted to .ref strings)
 *   - Nested objects and arrays
 *   - No S3 calls during cache key generation!
 *
 * Value: Promise<AssetId> (for deduplication of concurrent identical requests)
 */
const contextHashCache = new LRUCache<string, Promise<AssetId>>({
  max: 1000, // Cache up to 1k unique contexts
  ttl: 1000 * 60 * 60, // 1 hour TTL (contexts are immutable)
  updateAgeOnGet: true, // Refresh TTL on access
})

/**
 * Get context asset hash with caching to avoid redundant S3 store() calls
 *
 * Typical usage: Most workflows use {} context → ~83% cache hit rate
 * Impact: Reduces S3 calls from ~14,952 to ~2,500, eliminates socket exhaustion
 * Promise deduplication: Merges concurrent identical requests
 */
export async function getContextAssetHash(context: V12Context): Promise<AssetId> {
  // Use jsonify() to create stable cache key (converts refs to strings, no S3 calls)
  const cacheKey = JSON.stringify(jsonify(context))

  // Check for in-flight or resolved promise
  const cachedPromise = contextHashCache.get(cacheKey)
  if (cachedPromise) {
    return await cachedPromise
  }

  // Cache miss - create and cache promise
  const s3StoreLimiter = getLimiter('s3-store')
  const hashPromise = s3StoreLimiter(async () => {
    return toAssetId(await store(context))
  })

  contextHashCache.set(cacheKey, hashPromise)

  try {
    return await hashPromise
  }
  catch (error) {
    // Remove failed promise from cache to allow retry
    contextHashCache.delete(cacheKey)
    throw error
  }
}

// ================================================================
// WORKFLOW TASK ID LOOKUP CACHING
// ================================================================

/**
 * Cache for workflowRevisionId → workflowTaskId lookups
 *
 * Mapping is immutable - a workflow revision ID always belongs to the same task
 * This cache eliminates redundant GraphQL queries in onTaskDelivered()
 */
const workflowTaskIdCache = new LRUCache<TraceId, TraceId>({
  max: 5000, // Cache up to 5k workflow revisions
  ttl: 1000 * 60 * 60, // 1 hour TTL (mapping is immutable)
  updateAgeOnGet: true, // Refresh TTL on access
})

/**
 * Get workflow task ID from workflow revision ID
 * Queries the Versions table to find the task that owns this revision version
 * Now uses shared client instance with caching and concurrency limiting
 */
export async function getWorkflowTaskIdFromRevisionId(
  workflowRevisionId: TraceId,
): Promise<TraceId | null> {
  // Check cache first
  const cached = workflowTaskIdCache.get(workflowRevisionId)
  if (cached) {
    return cached
  }

  const graphqlClient = getSharedGraphQLClient()
  const limiter = getLimiter('task-polling')

  try {
    // Query with concurrency limiting
    const version = await limiter(async () => {
      return await graphqlClient.getVersion(workflowRevisionId)
    })

    if (version && version.type === 'REVISION') {
      const taskId = version.taskId as TraceId
      workflowTaskIdCache.set(workflowRevisionId, taskId)
      return taskId
    }

    console.warn(
      `⚠️  Version ${workflowRevisionId} is not a REVISION version or doesn't exist`,
    )
    return null
  }
  catch (error) {
    console.error(
      `Error getting workflow task ID for revision ${workflowRevisionId}:`,
      error,
    )
    return null
  }
}

// ================================================================
// V12 MODEL OPERATIONS (replaces DynamoDB)
// ================================================================

/**
 * Create task for pipeline node and update workflow state
 * Replaces: createTaskRecord()
 *
 * NOTE: Caching and concurrency limiting are now handled at the GraphQL client level
 * (see PipelineGraphQLClient.updateNodeStates)
 *
 * @param dependencyStatus - Dependency status: "FRESH" for first run/player input, "STALE" for recreation
 */
export async function createTaskRecord(
  _pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node>,
  task: Task,
  workflowContext: V12WorkflowExecutionContext,
  lastInputsHash: AssetId,
  dependencyStatus: 'FRESH' | 'STALE' = 'FRESH', // Default to FRESH for first-run scenarios
): Promise<void> {
  const contextAssetHash = await getContextAssetHash(context)
  const graphqlClient = getSharedGraphQLClient()

  // Check task execution state to determine runtime status
  // Map TaskExecutionState.runtimeStatus to WorkflowRevisionNodeState.runtimeStatus:
  //   - SUCCEEDED → IDLE (task completed successfully)
  //   - FAILED → FAILED (task execution failed)
  //   - PENDING/RUNNING → RUNNING (task is pending or executing, default behavior)
  let runtimeStatus: 'IDLE' | 'RUNNING' | 'FAILED' = 'RUNNING'

  const executionState = await graphqlClient.getTaskExecutionState(task.id)
  if (executionState) {
    const status = executionState.runtimeStatus
    if (status === 'SUCCEEDED') {
      runtimeStatus = 'IDLE' // Task already succeeded
      console.log(`📋 Task ${task.id} already succeeded, setting node to IDLE`)
    }
    else if (status === 'FAILED') {
      runtimeStatus = 'FAILED' // Task already failed
      console.log(`📋 Task ${task.id} already failed, setting node to FAILED`)
    }
    // PENDING/RUNNING: Keep default runtimeStatus = "RUNNING"
  }

  // Update WorkflowRevisionNodeStates (caching + concurrency handled by client)
  const success = await graphqlClient.updateNodeStates(
    workflowContext.workflowRevisionId,
    [
      {
        nodeId: node.id,
        dependencyStatus: dependencyStatus,
        runtimeStatus: runtimeStatus, // RUNNING/IDLE/FAILED based on task execution state
        contextAssetHash: contextAssetHash,
        requiredTaskId: task.id, // Critical: Link the task to this workflow node for reverse lookup
        lastInputsHash: lastInputsHash, // Store inputs hash for redelivery detection
      },
    ],
  )

  if (!success) {
    throw new Error(`Failed to update node state for ${node.id}`)
  }

  console.log(
    `✅ Created task record: workflow=${workflowContext.workflowRevisionId}, node=${node.id}, task=${task.id}, inputsHash=${lastInputsHash}, depStatus=${dependencyStatus}, runtimeStatus=${runtimeStatus}`,
  )
}

/**
 * Get task for a specific pipeline node from workflow state
 * Replaces: getTask()
 */
export async function getTaskInputs(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node> | null, // null indicates pipeline output
  workflowContext: V12WorkflowExecutionContext,
): Promise<DictLazyAsset | null> {
  if (!node) {
    // Pipeline output tasks are not tracked in WorkflowRevisionNodeStates
    return null
  }

  const graphqlClient = getSharedGraphQLClient()

  const contextAssetHash = await getContextAssetHash(context)

  // Query WorkflowRevisionNodeStates to find the task for this node
  const nodeState = await graphqlClient.getWorkflowRevisionNodeState(
    workflowContext.workflowRevisionId,
    node.id,
    contextAssetHash,
  )

  if (!nodeState?.requiredTaskId) {
    console.log(
      `🔍 No task found for: workflow=${workflowContext.workflowRevisionId}, node=${node.id}, context=${contextAssetHash}`,
    )
    return null
  }

  // Get the Task using the requiredTaskId
  const task = await graphqlClient.getTask(nodeState.requiredTaskId)

  if (!task?.inputsContentHash) {
    console.log(
      `🔍 No inputsContentHash found for: workflow=${workflowContext.workflowRevisionId}, node=${node.id}, task=${nodeState.requiredTaskId}`,
    )
    return null
  }

  console.log(
    `✅ Found task: workflow=${workflowContext.workflowRevisionId}, node=${node.id}, task=${nodeState.requiredTaskId}`,
  )
  return (await load(`@${task.inputsContentHash}`)) as DictLazyAsset
}

/**
 * Get all task records for a specific task (reverse lookup)
 * Replaces: getTaskRecords()
 * @param workflowRevisionId Optional workflow revision ID for server-side filtering optimization
 */
export async function getTaskRecords(
  _pipeline: CompoundAssetReference<Pipeline>,
  task: Task,
  workflowRevisionId?: TraceId,
): Promise<TaskTableRecord[]> {
  const graphqlClient = getSharedGraphQLClient()

  // Paginate through all records using cursor-based pagination
  const allTaskRecords: TaskTableRecord[] = []
  let hasNextPage = true
  let cursor: string | undefined = undefined
  const pageSize = 50

  while (hasNextPage) {
    // Query WorkflowRevisionNodeStates by task_id to find all workflow nodes using this task
    // Pass optional workflowRevisionId for server-side filtering
    const connection = await graphqlClient.listWorkflowRevisionNodeStatesByTask(
      task.id,
      pageSize,
      cursor,
      workflowRevisionId, // optional workflow revision ID filter
    )

    // Convert GraphQL response to TaskTableRecord format
    const pageRecords: TaskTableRecord[] = connection.edges.map((edge) => {
      const nodeState = edge.node

      // Create context reference from contextAssetHash
      const contextRef = new CompoundAssetReference<V12Context>(
        nodeState.contextAssetHash,
        null,
      )

      // Create node reference
      const nodeRef = new CompoundAssetReference<Node>(
        nodeState.nodeIdInWorkflow as AssetId,
        null,
      )

      return {
        workflowRevisionId: nodeState.workflowRevisionId as TraceId,
        context: contextRef,
        node: nodeRef,
        task: task,
      }
    })

    allTaskRecords.push(...pageRecords)

    // Check if there are more pages
    hasNextPage = connection.pageInfo.hasNextPage
    cursor = connection.pageInfo.endCursor || undefined
  }

  console.log(
    `🔍 Found ${allTaskRecords.length} task records for task: ${task.id}${workflowRevisionId ? ` (filtered by workflow ${workflowRevisionId})` : ''}`,
  )

  return allTaskRecords
}

/**
 * Create pending task record in merge accumulator
 * Replaces: createPendingTaskRecord()
 */
export async function createPendingTaskRecord(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node> | null, // null indicates pipeline output
  asset: DictLazyAsset,
  workflowContext: V12WorkflowExecutionContext,
): Promise<PendingTaskTableRecord> {
  if (!node) {
    throw new Error(
      'Cannot create pending task record for pipeline output (node is null)',
    )
  }

  const graphqlClient = getSharedGraphQLClient()
  const contextRef = await toReference(context)
  const contextAssetHash = contextRef.id

  // provide the asset to the merge accumulator via GraphQL
  await graphqlClient.setMergeAccumulator(
    pipeline.id,
    workflowContext.workflowRevisionId,
    contextAssetHash,
    node.id,
    asset,
  )

  console.log(
    `✅ Created pending task record: workflow=${workflowContext.workflowRevisionId}, node=${node.id}`,
  )

  return {
    workflowRevisionId: workflowContext.workflowRevisionId,
    context: contextRef,
    node,
  }
}

/**
 * Get pending task inputs from merge accumulator
 * Replaces: getPendingTask()
 */
export async function getPendingTaskInputs(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node> | null, // null indicates pipeline output
  workflowContext: V12WorkflowExecutionContext,
): Promise<DictLazyAsset | null> {
  if (!node) {
    return null // Pipeline output doesn't have pending tasks
  }

  const graphqlClient = getSharedGraphQLClient()
  const contextAssetHash = await getContextAssetHash(context)

  const accumulator = await graphqlClient.getMergeAccumulator(
    pipeline.id,
    workflowContext.workflowRevisionId,
    contextAssetHash,
    node.id,
  )

  if (!accumulator) {
    return null
  }

  return accumulator
}

/**
 * Delete pending task from merge accumulator
 * Replaces: deletePendingTask()
 */
export async function deletePendingTask(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node> | null, // null indicates pipeline output
  workflowContext: V12WorkflowExecutionContext,
) {
  if (!node) {
    return // Pipeline output doesn't have pending tasks
  }

  const graphqlClient = getSharedGraphQLClient()
  const contextAssetHash = await getContextAssetHash(context)

  await graphqlClient.deleteMergeAccumulator(
    pipeline.id,
    workflowContext.workflowRevisionId,
    contextAssetHash,
    node.id,
  )

  console.log(
    `🗑️  Deleted pending task: workflow=${workflowContext.workflowRevisionId}, node=${node.id}`,
  )
}

/**
 * Atomic merge update operation using GraphQL
 * Replaces: updateAndRetrieveTaskMergeAsset()
 */
export async function updateAndRetrieveTaskMergeAsset(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  node: CompoundAssetReference<Node> | null, // null indicates pipeline output
  key: string,
  item: LazyAsset,
  workflowContext: V12WorkflowExecutionContext,
): Promise<DictLazyAsset> {
  if (!node) {
    throw new Error(
      'Cannot update merge asset for pipeline output (node is null)',
    )
  }

  const graphqlClient = getSharedGraphQLClient()
  const contextAssetHash = await getContextAssetHash(context)

  // The merge accumulator stores a dict where each key maps to any LazyAsset value
  // The item can be a primitive, array, dict, reference, etc.
  const result = await graphqlClient.mergeMergeAccumulator(
    pipeline.id,
    workflowContext.workflowRevisionId,
    contextAssetHash,
    node.id,
    key,
    item,
  )

  if (!result) {
    throw new Error(`Failed to update merge accumulator for node ${node.id}, key ${key}`)
  }

  console.log(
    `🔄 Updated merge accumulator: workflow=${workflowContext.workflowRevisionId}, node=${node.id}, key=${key}`,
  )

  return result
}

/**
 * Update task status in workflow state
 * Replaces: updateTaskStatus()
 *
 * NOTE: This was a no-op in the original model.ts and remains a no-op in v12.
 * Task status is managed by Workers via TaskExecutionStates, not by the scheduler.
 */
export async function updateTaskStatus(
  _pipeline: CompoundAssetReference<Pipeline>,
  _task: ValueOrRef<Task>,
  eventType: string,
) {
  // No-op: Task status management is handled by Workers via TaskExecutionStates
  // This function exists for backward compatibility with scheduler.ts
  console.log(`📊 Update task status (no-op): event=${eventType}`)
}

// ================================================================
// TYPE DEFINITIONS (preserve existing interfaces)
// ================================================================

type TaskTableRecord = {
  workflowRevisionId: TraceId
  context: CompoundAssetReference<V12Context>
  node: CompoundAssetReference<Node>
  task: Task
}

type PendingTaskTableRecord = {
  workflowRevisionId: TraceId
  context: CompoundAssetReference<V12Context>
  node: CompoundAssetReference<Node> | null // null indicates pipeline output
}

// ================================================================
// DEBUGGING & MONITORING HELPERS
// ================================================================

/**
 * Get workflow execution state for debugging
 */
export async function debugGetWorkflowState(
  pipeline: CompoundAssetReference<Pipeline>,
  context: V12Context,
  workflowContext: V12WorkflowExecutionContext,
): Promise<{
  workflowRevisionId: TraceId
  contextAssetHash: AssetId
  pendingMergeNodes: Array<{ nodeId: AssetId, accumulator: DictLazyAsset }>
}> {
  const contextAssetHash = await getContextAssetHash(context)

  // Note: getPendingMergeNodes not implemented in GraphQL API
  // This is a debug function - would need to add listMergeAccumulatorsByWorkflowRevision query
  // to GraphQL schema for full functionality
  console.warn('debugGetWorkflowState: getPendingMergeNodes not yet implemented in GraphQL API')

  return {
    workflowRevisionId: workflowContext.workflowRevisionId,
    contextAssetHash,
    pendingMergeNodes: [], // TODO: Implement listMergeAccumulatorsByWorkflowRevision GraphQL query
  }
}

/**
 * Get statistics about merge accumulator usage
 * Note: Not implemented - would need GraphQL statistics query
 */
export async function debugGetMergeStatistics(): Promise<{
  totalAccumulators: number
  pipelineCount: number
  workflowRevisionCount: number
}> {
  console.warn('debugGetMergeStatistics: Not implemented in GraphQL API')

  return {
    totalAccumulators: 0, // TODO: Implement statistics query in GraphQL
    pipelineCount: 0,
    workflowRevisionCount: 0,
  }
}
