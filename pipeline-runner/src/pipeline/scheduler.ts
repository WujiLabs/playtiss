// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import {
  type ActionId,
  type AssetId,
  type AssetValue,
  type DictAsset,
} from 'playtiss'
import { computeHash, load, store } from 'playtiss/asset-store'
import { type Edge, isConstNode } from 'playtiss/pipeline'
import {
  type NodeSlotInfo,
  parsePipeline,
  type PipelineInfo,
} from 'playtiss/pipeline/parser'
import { isTraceId, type TraceId } from 'playtiss/types/trace_id'

import type { Task } from '../graphql/types.js'
import { getLimiter, withLimit } from '../utils/concurrency-limiter.js'
import {
  createPartialTaskInputs,
  createTaskRecord,
  deletePartialTaskInputs,
  getContextAssetHash,
  getPartialTaskInputs,
  getSharedGraphQLClient,
  getTaskInputs,
  getTaskRecords,
  getWorkflowTaskIdFromRevisionId,
  type MetaValues,
  updatePartialTaskInputs,
  type V12Context,
  type V12WorkflowExecutionContext,
} from './model.js'

// ================================================================
// v16 AUTO-PROPAGATION CONFIGURATION
// ================================================================

// When true, downstream nodes are automatically re-executed when upstream changes
// When false (default), downstream nodes are marked STALE and wait for manual update
const AUTO_PROPAGATE_STALE_NODES = process.env.PLAYTISS_AUTO_PROPAGATE === 'true'

// ================================================================
// TYPES
// ================================================================

/** Narrowed event type for pipeline task outcomes (replaces legacy EventType) */
type TaskOutcome = 'deliver' | 'abort' | 'update'

// ================================================================
// OPTIMIZED HELPER FUNCTIONS (use singleton GraphQL client)
// ================================================================

/**
 * Cache for V12Context asset loading to avoid redundant S3 load() calls
 *
 * Context asset content is immutable - same assetId always produces same value
 * This cache is critical for handleTaskCompletion() performance with high concurrency
 *
 * Typical case: Most workflows use the same few context values (often {})
 * With 20 parallel workflow records, without cache = 20 concurrent S3 loads for same context
 * Promise deduplication: Merges concurrent identical load requests
 */
const contextValueCache = new LRUCache<string, Promise<V12Context>>({
  max: 1000, // Cache up to 1k context values
  ttl: 1000 * 60 * 10, // 10 minute TTL (contexts are immutable)
  updateAgeOnGet: true, // Refresh TTL on access
})

/**
 * Limiter-aware load wrapper for V12Context (AssetId) with caching
 *
 * When handleTaskCompletion() processes 20 workflow records in parallel,
 * without this cache/limiter we'd have 20 concurrent uncached S3 load() calls
 *
 * @param contextAssetId - V12Context AssetId string
 * @returns The resolved context value
 */
async function toValueCachedContext(
  contextAssetId: AssetId,
): Promise<V12Context> {
  // Check cache using assetId string as key
  const cacheKey = contextAssetId
  const cachedPromise = contextValueCache.get(cacheKey)
  if (cachedPromise !== undefined) {
    return await cachedPromise
  }

  // Cache miss - create and cache promise
  const limiter = getLimiter('s3-load')
  const valuePromise = limiter(async () => {
    return (await load(contextAssetId)) as unknown as V12Context
  })

  contextValueCache.set(cacheKey, valuePromise)

  try {
    return await valuePromise
  }
  catch (error) {
    // Remove failed promise from cache to allow retry
    contextValueCache.delete(cacheKey)
    throw error
  }
}

/**
 * Optimized createTask using singleton GraphQL client with LRU cache
 * Replaces legacy createTask() that creates/destroys client on every call
 *
 * Architecture:
 * 1. client.createTask() returns only task ID (cached in LRU for deduplication)
 * 2. client.getTask() fetches full task content (cached by Apollo Client query cache)
 *
 * This two-step approach is intentional:
 * - Task IDs are immutable: same (actionId, input) always maps to same taskId
 * - Task content (currentVersion, etc.) can change externally and must be fetched fresh
 * - LRU cache eliminates redundant createTask mutations (~50% of calls)
 * - Apollo cache handles task content with network-only policy for freshness
 */
async function createTaskOptimized(
  actionId: ActionId,
  input: DictAsset,
): Promise<Task> {
  const client = getSharedGraphQLClient()
  const taskId = await client.createTask(actionId, input)
  const task = await client.getTask(taskId)
  if (!task) {
    throw new Error(`Failed to retrieve created task ${taskId}`)
  }
  return task
}

/**
 * Optimized writeEvent using singleton GraphQL client
 * Replaces legacy writeEvent() that creates/destroys client on every call
 */
async function reportTaskOutcome(
  taskId: TraceId,
  eventType: string,
  output?: DictAsset,
  workerId?: string,
): Promise<{ timestamp: number } | null> {
  const client = getSharedGraphQLClient()
  const actualWorkerId = workerId || 'workflow-engine'

  // Check if task is in terminal state (SUCCEEDED/FAILED) - redelivery scenario
  // This happens when submitPlayerInput creates a new REVISION but TaskExecutionStates still shows SUCCEEDED
  if (eventType === 'deliver' || eventType === 'abort') {
    const executionState = await client.getTaskExecutionState(taskId)
    if (executionState) {
      const status = executionState.runtimeStatus
      if (status === 'SUCCEEDED' || status === 'FAILED') {
        console.log(`🔄 Task ${taskId} is in terminal state ${status} (redelivery), refreshing and reclaiming...`)

        // Step 1: Refresh task (resets SUCCEEDED/FAILED back to PENDING)
        const refreshed = await client.refreshTask(taskId)
        if (!refreshed) {
          console.error(`❌ Failed to refresh task ${taskId} for redelivery`)
          return null
        }

        console.log(`✅ Refreshed task ${taskId} from ${status} to PENDING state`)

        // Step 2: Claim the task (this is claimTask, NOT claimWorkflowTask - no revision)
        const claimed = await client.claimTask(taskId, actualWorkerId)
        if (!claimed) {
          console.error(`❌ Failed to claim task ${taskId} after refresh`)
          return null
        }

        console.log(`✅ Successfully claimed task ${taskId} for redelivery`)
      }
    }
  }

  switch (eventType) {
    case 'deliver':
    {
      if (!output) {
        throw new Error('Output required for deliver event')
      }
      const deliverSuccess = await client.reportTaskSuccessWithOutput(
        taskId,
        output,
        actualWorkerId,
      )
      return deliverSuccess ? { timestamp: Date.now() } : null
    }
    case 'abort':
    {
      const errorData = output || { error: 'Task aborted' }
      const abortSuccess = await client.reportTaskFailureWithError(
        taskId,
        errorData,
        actualWorkerId,
      )
      return abortSuccess ? { timestamp: Date.now() } : null
    }
    case 'update':
      // Update event is a no-op in Phase 1 but return success marker
      return { timestamp: Date.now() }
    default:
      console.warn(`Unsupported event type: ${eventType}`)
      return null
  }
}

function isOutputNode(
  node: TraceId | null,
): node is null {
  return node === null
}

async function reportPipelineTaskOutcome(
  context: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  asset: DictAsset,
  event_type: TaskOutcome,
) {
  // write event with the correct worker ID from workflow context
  // If no workerId is provided, reportTaskOutcome will use the default 'workflow-engine'
  const pipelineEvent = await reportTaskOutcome(
    workflowContext.workflowTaskId,
    event_type,
    asset,
    workflowContext.workerId,
  )
  console.log('Pipeline:', pipelineEvent)
}

/**
 * Create a node task (deprecated function, kept for potential future use)
 * Note: processNodeReady is now the preferred function as it handles first run detection
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function createNodeTask(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  context: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  node: TraceId,
  asset: DictAsset,
): Promise<Task> {
  const actionId = pipelineInfo.nodes[node].action
  if (!isTraceId(actionId)) {
    throw new Error(`built in action ${actionId} is not separate task`)
  }

  // Store inputs as asset (inputs hash = asset ID)
  const limiter = getLimiter('s3-store')
  const inputsAssetId = await limiter(async () => store(asset))

  // Apply task-creation limiter here at the leaf operation level
  return await withLimit(async () => {
    const task = await createTaskOptimized(actionId, asset)
    await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH')
    return task
  }, 'task-creation')
}

/**
 * Process a node when its inputs are ready (v14 smart task creation)
 *
 * Logic:
 * - If node doesn't exist: First run → Create task immediately
 * - If node exists with same inputs: Skip (idempotent)
 * - If node exists with different inputs: Redelivery → Mark as STALE (requires user permission)
 *
 * Returns Task on first run, null on subsequent revisions
 */
async function processNodeReady(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  context: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  node: TraceId,
  combinedAsset: DictAsset, // contains both data keys and ^meta keys
): Promise<Task | null> {
  const actionId = pipelineInfo.nodes[node].action
  if (!isTraceId(actionId)) {
    throw new Error(`built in action ${actionId} is not separate task`)
  }

  // Separate data from meta — only data slots go into input hash
  const asset = stripMetaKeys(combinedAsset)
  const metaAsset = extractMetaKeys(combinedAsset)

  // Store inputs as asset (inputs hash = asset ID) — meta keys excluded
  const limiter = getLimiter('s3-store')
  const inputsAssetId = await limiter(async () => store(asset))

  // Store meta asset if non-empty
  const metaAssetHash = Object.keys(metaAsset).length > 0
    ? await limiter(async () => store(metaAsset))
    : null

  const contextAssetHash = await getContextAssetHash(context)
  const graphqlClient = getSharedGraphQLClient()

  // Check if node already exists
  const existingNodeState = await graphqlClient.getNodeState(
    workflowContext.workflowRevisionId,
    node,
    contextAssetHash,
  )

  console.log(`🔍 DEBUG processNodeReady: node=${node}, workflowRevisionId=${workflowContext.workflowRevisionId}`)
  console.log(`🔍 DEBUG existingNodeState:`, existingNodeState
    ? {
        requiredTaskId: existingNodeState.requiredTaskId,
        lastInputsHash: existingNodeState.lastInputsHash,
        dependencyStatus: existingNodeState.dependencyStatus,
        runtimeStatus: existingNodeState.runtimeStatus,
      }
    : 'NULL')
  console.log(`🔍 DEBUG new inputsAssetId: ${inputsAssetId}`)

  // Case 1: Node doesn't exist → First run, create task immediately
  if (!existingNodeState || !existingNodeState.requiredTaskId) {
    console.log(`🆕 First run detected for node ${node}, creating task immediately`)

    return await withLimit(async () => {
      const task = await createTaskOptimized(actionId, asset)
      await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH', metaAssetHash)
      return task
    }, 'task-creation')
  }

  // Case 2: Node exists with same inputs → Skip (idempotent)
  if (existingNodeState.lastInputsHash === inputsAssetId) {
    console.log(`✅ Node ${node} inputs unchanged, skipping`)
    return null
  }

  // Case 3: Node exists with different inputs → Recreation
  console.log(`🔄 Recreation detected for node ${node} (inputs changed)`)

  if (AUTO_PROPAGATE_STALE_NODES) {
    // THROUGHPUT MODE: Auto-create task and schedule immediately
    console.log(`⚡ Auto-propagate ENABLED: creating task for stale node ${node}`)

    return await withLimit(async () => {
      // Create task (GraphQL mutation automatically schedules it as PENDING)
      const task = await createTaskOptimized(actionId, asset)

      // createTaskRecord will:
      // - Set dependencyStatus = "FRESH" (we're processing the input change)
      // - Check TaskExecutionState.runtimeStatus (PENDING) → map to RUNNING
      // - Set requiredTaskId = task.id
      // - Set lastInputsHash = inputsAssetId
      await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH', metaAssetHash)

      console.log(`✅ Auto-created task ${task.id} for stale node ${node}`)
      return task
    }, 'task-creation')
  }
  else {
    // INTERACTIVE MODE (Default): Mark STALE/IDLE, wait for user
    console.log(`⏸️  Auto-propagate DISABLED: marking node ${node} as STALE/IDLE`)

    const success = await graphqlClient.updateNodeStates(
      workflowContext.workflowRevisionId,
      [{
        nodeId: node,
        dependencyStatus: 'STALE' as const,
        runtimeStatus: 'IDLE' as const,
        contextAssetHash: contextAssetHash,
        requiredTaskId: null, // Clear old task reference
        lastInputsHash: inputsAssetId, // Store new inputs hash
      }],
    )

    if (!success) {
      throw new Error(`Failed to mark node ${node} as STALE for recreation`)
    }

    console.log(`✅ Marked node as STALE/IDLE: workflow=${workflowContext.workflowRevisionId}, node=${node}, inputsHash=${inputsAssetId}`)
    return null // Task creation waits for user permission (requestStaleNodesUpdate)
  }
}

function isContextSlot(name: string): name is `%${string}` {
  return name.startsWith('%')
}

function isMetaSlot(name: string): name is `^${string}` {
  return name.startsWith('^')
}

function stripMetaKeys(asset: DictAsset): DictAsset {
  const result: DictAsset = {}
  for (const [key, value] of Object.entries(asset)) {
    if (!key.startsWith('^')) result[key] = value
  }
  return result
}

function extractMetaKeys(asset: DictAsset): MetaValues {
  const result: MetaValues = {}
  for (const [key, value] of Object.entries(asset)) {
    if (isMetaSlot(key)) result[key] = value
  }
  return result
}

async function resolveNestedValue(
  asset: DictAsset,
  key: string,
): Promise<AssetValue> {
  const keys = key.split('.')
  if (keys.length === 0) {
    throw new Error('not valid key string')
  }
  let retAsset: AssetValue = asset
  for (const k of keys) {
    if (
      retAsset !== null
      && typeof retAsset === 'object'
      && !(retAsset instanceof Uint8Array)
      && !Array.isArray(retAsset)
    ) {
      const v: AssetValue = (retAsset as DictAsset)[k]
      retAsset = v
    }
    else {
      throw new Error('not valid DictAsset')
    }
  }
  return retAsset
}

// ================================================================
// Edge Resolution: extract context + asset from edge lists
// ================================================================

/**
 * Resolve tag edges into a context object.
 */
async function resolveContextEdges(
  tagEdges: Edge[],
  currentContext: V12Context,
  currentAsset: DictAsset,
): Promise<V12Context> {
  const nextContext: V12Context = {}
  for (const { source, target } of tagEdges) {
    const value = isContextSlot(source.name)
      ? currentContext[source.name]
      : isMetaSlot(source.name)
        ? currentAsset[source.name]
        : await resolveNestedValue(currentAsset, source.name)
    if (value !== undefined) {
      nextContext[target.name as `%${string}`] = value
    }
    else {
      console.warn(`property ${source.name} does not exist!`)
    }
  }
  return nextContext
}

/**
 * Resolve slot edges into an asset, merging into an existing base asset.
 */
async function resolveDataEdges(
  slotEdges: Edge[],
  currentContext: V12Context,
  currentAsset: DictAsset,
  baseAsset: DictAsset,
): Promise<DictAsset> {
  const nextAsset: DictAsset = { ...baseAsset }
  for (const { source, target } of slotEdges) {
    const value = isContextSlot(source.name)
      ? currentContext[source.name]
      : isMetaSlot(source.name)
        ? currentAsset[source.name]
        : await resolveNestedValue(currentAsset, source.name)
    if (value !== undefined) {
      nextAsset[target.name] = value
    }
    else {
      console.warn(`property ${source.name} does not exist!`)
    }
  }
  return nextAsset
}

/**
 * Resolve meta edges into an asset dict with ^-prefixed keys.
 * Meta values ride alongside data values in the same dict but are stripped before task input hashing.
 */
async function resolveMetaEdges(
  metaEdges: Edge[],
  currentContext: V12Context,
  currentAsset: DictAsset,
  baseAsset: DictAsset,
): Promise<DictAsset> {
  const result: DictAsset = { ...baseAsset }
  for (const { source, target } of metaEdges) {
    const value = isContextSlot(source.name)
      ? currentContext[source.name]
      : isMetaSlot(source.name)
        ? currentAsset[source.name]
        : await resolveNestedValue(currentAsset, source.name)
    if (value !== undefined) {
      result[target.name] = value
    }
    else {
      console.warn(`property ${source.name} does not exist!`)
    }
  }
  return result
}

// ================================================================
// Critical zone lock for merge nodes
// ================================================================

/**
 * Critical zone lock for merge nodes to prevent race conditions.
 *
 * When multiple async calls try to process the same merge node simultaneously,
 * they could read and write the pending task state concurrently, leading to:
 * - Lost updates (one call's changes overwriting another's)
 * - Duplicate task creation
 * - Incorrect merge state
 *
 * The lock ensures only one async call processes a given merge node at a time,
 * while allowing different workflow revisions to process their own merge nodes independently.
 *
 * Structure: Map<workflowRevisionId, Map<nextNodeId, Promise>>
 * - First level key: workflowRevisionId (TraceId) - different revisions don't block each other
 * - Second level key: nextNodeId (TraceId) - identifies the merge node
 * - Value: Promise that resolves when the critical zone completes
 *
 * TODO: Consider cleanup of completed workflow revisions to prevent unbounded memory growth.
 * Currently kept for simplicity as the map is bounded by number of concurrent workflows.
 */
const criticalZoneLock = new Map<
  TraceId,
  Map<TraceId, Promise<void>>
>()

async function acquireMergeNodeLock(
  revisionId: TraceId,
  nodeId: TraceId,
  promise: Promise<void>,
): Promise<void> {
  let revisionLocks = criticalZoneLock.get(revisionId)
  if (!revisionLocks) {
    revisionLocks = new Map<TraceId, Promise<void>>()
    criticalZoneLock.set(revisionId, revisionLocks)
  }
  const existingLock = revisionLocks.get(nodeId)
  revisionLocks.set(nodeId, promise)
  if (existingLock) {
    await existingLock
  }
}

// ================================================================
// Node-type handler strategies
// ================================================================

type PropagateResult = Task | Task[] | null

interface NodeHandlerArgs {
  pipeline: AssetId
  pipelineInfo: PipelineInfo
  workflowContext: V12WorkflowExecutionContext
  nextNode: TraceId | null
  nextNodeSlots: string[]
  nextMetaSlots: string[]
  nextContext: V12Context
  nextAsset: DictAsset // contains both data keys and ^meta keys
}

async function handleRegularNode(args: NodeHandlerArgs): Promise<PropagateResult> {
  const { pipeline, pipelineInfo, workflowContext, nextNode, nextContext, nextAsset } = args
  if (isOutputNode(nextNode)) {
    await reportPipelineTaskOutcome(nextContext, workflowContext, stripMetaKeys(nextAsset), 'deliver')
    return null
  }
  return await processNodeReady(pipeline, pipelineInfo, nextContext, workflowContext, nextNode, nextAsset)
}

async function handleMergeNode(args: NodeHandlerArgs): Promise<PropagateResult> {
  const { pipeline, pipelineInfo, workflowContext, nextNode, nextNodeSlots, nextMetaSlots, nextContext, nextAsset } = args
  // If all inputs are ready (data slots AND meta slots)
  const allReady = nextNodeSlots.every(name => name in nextAsset)
    && nextMetaSlots.every(name => name in nextAsset)
  if (allReady) {
    await deletePartialTaskInputs(pipeline, nextContext, nextNode, workflowContext)
    if (isOutputNode(nextNode)) {
      await reportPipelineTaskOutcome(nextContext, workflowContext, stripMetaKeys(nextAsset), 'deliver')
      return null
    }
    return await processNodeReady(pipeline, pipelineInfo, nextContext, workflowContext, nextNode, nextAsset)
  }
  // Not all inputs ready — persist partial state and wait
  await createPartialTaskInputs(pipeline, nextContext, nextNode, nextAsset, workflowContext)
  return null
}

async function handleTaskSplitNode(args: NodeHandlerArgs): Promise<PropagateResult> {
  const { pipeline, pipelineInfo, workflowContext, nextNode, nextContext, nextAsset } = args
  if (isOutputNode(nextNode)) {
    throw new Error('Output node cannot have builtin action')
  }
  return fanOutSplit(pipeline, pipelineInfo, nextContext, workflowContext, nextAsset, nextNode)
}

async function handleTaskMergeNode(args: NodeHandlerArgs): Promise<PropagateResult> {
  const { pipeline, pipelineInfo, workflowContext, nextNode, nextContext, nextAsset } = args
  if (isOutputNode(nextNode)) {
    throw new Error('Output node cannot have builtin action')
  }
  const keys = nextAsset.keys
  if (typeof keys === 'number') {
    // Array merge
    const tmpAsset = await updatePartialTaskInputs(
      pipeline, nextContext, nextNode, (nextAsset.key as number).toFixed(0), nextAsset.item, workflowContext,
    )
    if (Object.keys(tmpAsset).length === keys) {
      const outputAsset = Array.from({ length: keys }, (_, i) => tmpAsset[i.toFixed(0)])
      return forwardMergeOutput(pipeline, pipelineInfo, nextContext, workflowContext, { output: outputAsset }, nextNode)
    }
    // Not all inputs ready — accumulator updated atomically, wait for remaining
    return null
  }
  if (Array.isArray(keys)) {
    // Object merge
    const tmpAsset = await updatePartialTaskInputs(
      pipeline, nextContext, nextNode, nextAsset.key as string, nextAsset.item, workflowContext,
    )
    if (keys.every(key => typeof key === 'string' && key in tmpAsset)) {
      const outputAsset = tmpAsset
      return forwardMergeOutput(pipeline, pipelineInfo, nextContext, workflowContext, { output: outputAsset }, nextNode)
    }
    // Not all inputs ready — accumulator updated atomically, wait for remaining
    return null
  }
  throw new Error('Invalid keys type')
}

async function handleConstNode(args: NodeHandlerArgs): Promise<PropagateResult> {
  const { pipeline, pipelineInfo, workflowContext, nextNode, nextContext } = args
  if (isOutputNode(nextNode)) {
    throw new Error('Output node cannot be a const node')
  }
  const nodeData = pipelineInfo.nodes[nextNode!]
  if (!isConstNode(nodeData)) {
    throw new Error(`Node ${nextNode} is marked as const but missing value property`)
  }
  const constOutput: DictAsset = { output: nodeData.value }
  const constResults: PropagateResult[] = []
  for (const nodeSlotInfo of pipelineInfo.node_nexts[nextNode!]) {
    constResults.push(
      await propagateToNode(
        pipeline, pipelineInfo, nextContext, workflowContext, constOutput, nodeSlotInfo,
      ),
    )
  }
  return flattenTasks(constResults)
}

/** Strategy map: dispatch by node type */
const nodeHandlers: Record<string, (args: NodeHandlerArgs) => Promise<PropagateResult>> = {
  regular: handleRegularNode,
  merge: handleMergeNode,
  task_split: handleTaskSplitNode,
  task_merge: handleTaskMergeNode,
  const: handleConstNode,
}

// ================================================================
// Core dispatch: propagate data to a downstream node
// ================================================================

async function propagateToNode(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  { node: nextNodeId, context_edges, data_edges, meta_edges }: NodeSlotInfo,
): Promise<PropagateResult> {
  // Create a promise to signal when this call's critical zone completes
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  try {
    const nextNode = nextNodeId
    const nextNodeType = nextNodeId === null
      ? pipelineInfo.output_type
      : pipelineInfo.node_types[nextNodeId]
    const nextNodeSlots = nextNodeId === null
      ? pipelineInfo.output_slots
      : pipelineInfo.node_slots[nextNodeId]
    const nextMetaSlots = nextNodeId === null
      ? []
      : pipelineInfo.node_meta_slots[nextNodeId] || []

    // Step 1: Resolve context from tag edges (needed for merge state lookup)
    const nextContext = await resolveContextEdges(context_edges, currentContext, currentAsset)

    // Step 2: For merge nodes, acquire lock and load existing state
    let baseAsset: DictAsset = {}
    if (nextNodeType === 'merge') {
      await acquireMergeNodeLock(workflowContext.workflowRevisionId, nextNodeId!, promise)
      // Spread to create mutable copy (IPLD dag-json returns frozen objects)
      baseAsset = {
        ...(await getPartialTaskInputs(pipeline, nextContext, nextNode, workflowContext)
          || await getTaskInputs(pipeline, nextContext, nextNode, workflowContext)
          || {}),
      }
    }

    // Step 3: Resolve data from slot edges, merging into base asset
    const dataAsset = await resolveDataEdges(data_edges, currentContext, currentAsset, baseAsset)

    // Step 4: Resolve meta edges into the same asset (^ keys ride alongside data keys)
    const nextAsset = await resolveMetaEdges(meta_edges, currentContext, currentAsset, dataAsset)

    // Dispatch to the appropriate handler
    const handler = nodeHandlers[nextNodeType]
    if (!handler) {
      throw new Error(`Unknown node type: ${nextNodeType}`)
    }
    return await handler({
      pipeline, pipelineInfo, workflowContext,
      nextNode, nextNodeSlots, nextMetaSlots, nextContext, nextAsset,
    })
  }
  catch (error) {
    reject(error)
    throw error
  }
  finally {
    // Release the lock by resolving the promise
    // This allows the next waiting call (if any) to proceed
    //
    // IMPORTANT: We don't remove the entry from revisionLocks or criticalZoneLock
    // By the time we resolve, another async call may have already:
    // 1. Read our promise from revisionLocks
    // 2. Set their own promise
    // 3. Started waiting on our promise
    //
    // If we deleted the entry here, we'd delete THEIR lock, not ours!
    // The maps are naturally bounded by:
    // - criticalZoneLock: number of concurrent workflow revisions
    // - revisionLocks: number of unique merge nodes in the pipeline
    resolve()
  }
}

function flattenTasks(
  tasks: PropagateResult[],
): Task[] {
  return tasks
    .flat()
    .filter((item): item is Task => item !== null)
}

async function fanOutSplit(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  node: TraceId,
): Promise<Task[]> {
  const input = await ensureDictOrArrayAsset(
    currentAsset['input'],
  )

  if (Array.isArray(input)) {
    const keys = input.length
    console.log(`🔀 Split input is ARRAY with ${keys} items`)
    const allItemResults: PropagateResult[] = []
    for (let key = 0; key < input.length; key++) {
      const item = input[key]
      const nodeResults: PropagateResult[] = []
      for (const nodeSlotInfo of pipelineInfo.node_nexts[node]) {
        nodeResults.push(
          await propagateToNode(
            pipeline,
            pipelineInfo,
            currentContext,
            workflowContext,
            { keys, key, item },
            nodeSlotInfo,
          ),
        )
      }
      allItemResults.push(flattenTasks(nodeResults))
    }
    return flattenTasks(allItemResults)
  }
  else {
    const keys = Object.keys(input)
    const entries = Object.entries(input)
    console.log(`🔀 Split input is OBJECT with ${keys.length} keys`)

    try {
      const allEntryResults: Task[][] = []
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const [key, item] = entries[entryIndex]
        try {
          const nodeResults: PropagateResult[] = []
          const nextNodes = pipelineInfo.node_nexts[node]
          for (let index = 0; index < nextNodes.length; index++) {
            try {
              nodeResults.push(
                await propagateToNode(
                  pipeline,
                  pipelineInfo,
                  currentContext,
                  workflowContext,
                  { keys, key, item },
                  nextNodes[index],
                ),
              )
            }
            catch (error) {
              console.error(
                `❌ ERROR in propagateToNode for key ${key}, node ${index + 1}:`,
                error,
              )
              throw error
            }
          }
          allEntryResults.push(flattenTasks(nodeResults))
        }
        catch (error) {
          console.error(
            `❌ ERROR processing key ${key} (entry ${entryIndex + 1}):`,
            error,
          )
          throw error
        }
      }
      return flattenTasks(allEntryResults)
    }
    catch (error) {
      console.error(`❌ FATAL ERROR in fanOutSplit:`, error)
      console.error(`❌ Error stack:`, (error as Error).stack)
      throw error
    }
  }
}

async function forwardMergeOutput(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  node: TraceId,
): Promise<Task[]> {
  const results: PropagateResult[] = []
  for (const nodeSlotInfo of pipelineInfo.node_nexts[node]) {
    results.push(
      await propagateToNode(
        pipeline,
        pipelineInfo,
        currentContext,
        workflowContext,
        currentAsset,
        nodeSlotInfo,
      ),
    )
  }
  return flattenTasks(results)
}

// on pipeline claimed
// * pass pipeline inputs to nodes
// * process const nodes (source nodes with no incoming edges)
export async function handleWorkflowStart(
  claimEvent: {
    task: Task
    workflowRevisionId: TraceId
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
): Promise<Task[]> {
  const workflowContext: V12WorkflowExecutionContext = {
    workflowTaskId: claimEvent.task.id,
    workflowRevisionId: claimEvent.workflowRevisionId,
    workerId: workerId,
  }
  const currentContext: V12Context = {}
  // get input
  const { inputsContentHash } = claimEvent.task
  const input = (await load(
    inputsContentHash as AssetId,
  )) as DictAsset
  console.log(`📋 Loaded workflow input:`, JSON.stringify(input, null, 2))

  // compute/fetch pipeline info
  const pipelineInfo: PipelineInfo = await parsePipeline(pipeline)
  console.log(
    `📋 Pipeline info - input_next length:`,
    pipelineInfo.input_next.length,
  )
  console.log(
    `📋 Pipeline info - nodes:`,
    Object.keys(pipelineInfo.nodes || {}),
  )

  // Collect all initialization results
  const allResults: Task[] = []

  // 1. Process pipeline input connections
  const inputLimit = pLimit(concurrency)
  const inputResults = await Promise.all(
    pipelineInfo.input_next.map(nodeSlotInfo =>
      inputLimit(() =>
        propagateToNode(
          pipeline,
          pipelineInfo,
          currentContext,
          workflowContext,
          input,
          nodeSlotInfo,
        ),
      ),
    ),
  )
  allResults.push(...flattenTasks(inputResults))

  // 2. Process const nodes (source nodes with no incoming edges)
  // Const nodes need to be initialized here since they have no upstream connections
  const constNodeRefs = Object.entries(pipelineInfo.node_types)
    .filter(([, nodeType]) => nodeType === 'const')
    .map(([nodeRef]) => nodeRef as TraceId)

  if (constNodeRefs.length > 0) {
    console.log(`📋 Processing ${constNodeRefs.length} const nodes:`, constNodeRefs)

    for (const constNodeRef of constNodeRefs) {
      const nodeId = constNodeRef
      const nodeData = pipelineInfo.nodes[nodeId]

      if (!isConstNode(nodeData)) {
        console.warn(`Node ${nodeId} is marked as const but missing value property`)
        continue
      }

      // Create const node output (single 'output' slot)
      const constOutput: DictAsset = { output: nodeData.value }

      // Get downstream nodes for this const node
      const nextNodes = pipelineInfo.node_nexts[constNodeRef] || []

      if (nextNodes.length === 0) {
        console.warn(`Const node ${nodeId} has no downstream connections`)
        continue
      }

      console.log(`📋 Const node ${nodeId} feeding ${nextNodes.length} downstream nodes`)

      // Process downstream nodes
      for (const nodeSlotInfo of nextNodes) {
        const result = await propagateToNode(
          pipeline,
          pipelineInfo,
          currentContext,
          workflowContext,
          constOutput,
          nodeSlotInfo,
        )
        if (result !== null) {
          allResults.push(...(Array.isArray(result) ? result.filter((r): r is Task => r !== null) : [result]))
        }
      }
    }
  }

  return allResults
}

type DictOrArrayAsset = DictAsset | AssetValue[]

async function ensureDictOrArrayAsset(
  asset: AssetValue,
): Promise<DictOrArrayAsset> {
  if (asset === null) {
    throw new Error('asset is null')
  }
  if (
    typeof asset === 'boolean'
    || typeof asset === 'number'
    || typeof asset === 'string'
  ) {
    throw new Error(`asset is primitive value: ${String(asset)}`)
  }
  if (asset instanceof Uint8Array) {
    throw new Error('asset is Uint8Array')
  }
  return asset as DictOrArrayAsset
}

async function ensureDictAsset(asset: AssetValue): Promise<DictAsset> {
  asset = await ensureDictOrArrayAsset(asset)
  if (Array.isArray(asset)) {
    throw new Error('asset is array')
  }
  return asset as DictAsset
}

// on task delivered
export async function handleTaskCompletion(
  deliverEvent: {
    task: Task
    output: AssetValue
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
  workflowRevisionId: TraceId, // current workflow revision ID for this orchestrator
): Promise<Task[]> {
  const { task, output: asset } = deliverEvent

  // compute/fetch pipeline info
  const pipelineInfo: PipelineInfo = await parsePipeline(pipeline)
  // find all context and node for this workflow revision ID (filtered server-side)
  const records = await getTaskRecords(pipeline, task, workflowRevisionId)
  if (records.length === 0) {
    console.warn(`❌ No records found for workflow revision ${workflowRevisionId}`)
    return []
  }

  // V14 Redelivery Detection: Check if this is a redelivery (output changed for an already-delivered node)
  // If yes, fork the revision before processing to preserve history
  // NOTE: A task may be used in multiple nodes/contexts, so we check ALL records
  if (records.length > 0) {
    const graphqlClient = getSharedGraphQLClient()
    const newOutputHash = await computeHash(asset)
    let revisionForked = false
    let newRevisionId: TraceId | undefined

    // Check each record to see if any represents a redelivery
    for (const record of records) {
      // Get the actual node state to check if it was already delivered
      const nodeState = await graphqlClient.getWorkflowRevisionNodeState(
        workflowRevisionId,
        record.node,
        record.context,
      )

      if (nodeState?.lastUsedVersion?.asset_content_hash) {
        // Node was previously delivered, check if output changed
        const oldOutputHash = nodeState.lastUsedVersion.asset_content_hash

        if (newOutputHash !== oldOutputHash) {
          // Redelivery detected! Fork revision to preserve history
          console.log(`🔀 Redelivery detected for node ${record.node}: ${oldOutputHash} → ${newOutputHash}`)

          const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflowRevisionId)
          if (workflowTaskId) {
            newRevisionId = await graphqlClient.forkWorkflowRevision(
              workflowTaskId,
              workflowRevisionId,
              `Redelivery of task ${task.id} in node ${record.node}`,
            )

            // Update workflowRevisionId to point to the new revision for subsequent operations
            workflowRevisionId = newRevisionId
            revisionForked = true

            // No need to check remaining records since we've already forked
            break
          }
        }
      }
    }
    if (revisionForked) {
      console.log(`🔀 Forked revision: ${workflowRevisionId} → ${newRevisionId}`)
    }
  }

  // for each record:
  const recordLimit = pLimit(20) // Process workflow records in parallel (typical: 19-20 records)
  const nodeLimit = pLimit(concurrency)
  return flattenTasks(
    await Promise.all(
      records.map(({
        context,
        node,
      }) =>
        recordLimit(async (): Promise<Task[]> => {
          const currentContext = await toValueCachedContext(context)

          // Use the potentially-forked workflowRevisionId instead of the one from record
          const effectiveWorkflowRevisionId = workflowRevisionId

          // Find the workflow task ID from the workflow revision ID
          const workflowTaskId = await getWorkflowTaskIdFromRevisionId(effectiveWorkflowRevisionId)
          if (!workflowTaskId) {
            console.error(
              `❌ Could not find workflow task ID for revision ${effectiveWorkflowRevisionId}`,
            )
            return []
          }

          // Construct workflow execution context per record
          const workflowContext: V12WorkflowExecutionContext = {
            workflowTaskId: workflowTaskId,
            workflowRevisionId: effectiveWorkflowRevisionId,
            workerId: workerId,
          }

          // find corresponding next nodes
          if (!(node in pipelineInfo.node_nexts)) {
            console.log(`⚠️  Node ${node} has no next nodes in pipeline`)
            return []
          }

          const nextNodes = pipelineInfo.node_nexts[node]

          // Re-attach meta values from WRNS so downstream edges can read ^sources
          let currentAssetWithMeta = await ensureDictAsset(asset)
          const nodeState = await getSharedGraphQLClient().getNodeState(
            effectiveWorkflowRevisionId,
            node,
            context,
          )
          if (nodeState?.metaAssetHash) {
            const metaValues = await load(nodeState.metaAssetHash as AssetId) as MetaValues
            currentAssetWithMeta = { ...currentAssetWithMeta, ...metaValues }
          }

          const results = flattenTasks(
            await Promise.all(
              nextNodes.map(nodeSlotInfo =>
                nodeLimit(async () =>
                  propagateToNode(
                    pipeline,
                    pipelineInfo,
                    currentContext,
                    workflowContext,
                    currentAssetWithMeta,
                    nodeSlotInfo,
                  ),
                ),
              ),
            ),
          )

          if (results.length > 0) {
            console.log(
              `📊 handleTaskCompletion returned ${results.length} dependent tasks`,
            )
          }
          return results
        }),
      ),
    ),
  )
}

// on task aborted
export async function handleTaskFailure(
  {
    task,
    output,
  }: {
    task: Task
    output: AssetValue
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
  workflowRevisionId: TraceId, // current workflow revision ID for this orchestrator
) {
  const asset = output !== null ? await ensureDictAsset(output) : null

  // Log the output asset to debug cache issues
  if (asset && asset.orders) {
    const orderKeys = Object.keys(asset.orders as Record<string, unknown>)
    console.log(
      `📦 handleTaskCompletion received asset with ${orderKeys.length} orders: [${orderKeys.slice(0, 5).join(', ')}${orderKeys.length > 5 ? ', ...' : ''}]`,
    )
  }
  // find all context and abort (filtered server-side)
  // TODO: abort other internal subtasks as well?
  const records = await getTaskRecords(pipeline, task, workflowRevisionId)
  if (records.length === 0) {
    console.warn(`❌ No records found for workflow revision ${workflowRevisionId}`)
    return
  }
  const abortLimit = pLimit(concurrency)
  await Promise.all(
    records.map(({ context, node, workflowRevisionId }) =>
      abortLimit(async () => {
        const currentContext = await toValueCachedContext(context)

        // Find the workflow task ID from the workflow revision ID
        const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflowRevisionId)
        if (!workflowTaskId) {
          console.error(
            `❌ Could not find workflow task ID for revision ${workflowRevisionId} in handleTaskFailure`,
          )
          return
        }

        // Construct workflow execution context per record
        const workflowContext: V12WorkflowExecutionContext = {
          workflowTaskId: workflowTaskId,
          workflowRevisionId: workflowRevisionId,
          workerId: workerId,
        }

        await reportPipelineTaskOutcome(
          currentContext,
          workflowContext,
          {
            node,
            ...asset,
          },
          'abort',
        )
      }),
    ),
  )
}

export async function handleTaskProgress(
  updateEvent: {
    task: Task
    output: AssetValue
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
  workflowRevisionId: TraceId, // current workflow revision ID for this orchestrator
) {
  const { task, output } = updateEvent
  const asset = output !== null ? await ensureDictAsset(output) : null

  // find all context and update (filtered server-side)
  const records = await getTaskRecords(pipeline, task, workflowRevisionId)
  if (records.length === 0) {
    console.warn(`❌ No records found for workflow revision ${workflowRevisionId}`)
    return
  }

  const updateLimit = pLimit(concurrency)
  await Promise.all(
    records.map(({ context, node, workflowRevisionId }) =>
      updateLimit(async () => {
        const currentContext = await toValueCachedContext(context)

        // Find the workflow task ID from the workflow revision ID
        const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflowRevisionId)
        if (!workflowTaskId) {
          console.error(
            `❌ Could not find workflow task ID for revision ${workflowRevisionId} in handleTaskProgress`,
          )
          return
        }

        // Construct workflow execution context per record
        const workflowContext: V12WorkflowExecutionContext = {
          workflowTaskId: workflowTaskId,
          workflowRevisionId: workflowRevisionId,
          workerId: workerId,
        }

        await reportPipelineTaskOutcome(
          currentContext,
          workflowContext,
          {
            node,
            ...asset,
          },
          'update',
        )
      }),
    ),
  )
}
