// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  type ActionId,
  type AssetId,
  type AssetValue,
  type DictAsset,
  type EventType,
  type SystemActionId,
  type ValueOrRef,
} from 'playtiss'
import { computeHash, load, store } from 'playtiss/asset-store'
import { type Node, type Pipeline, isConstNode } from 'playtiss/pipeline'
import {
  type NodeSlotInfo,
  type PipelineInfo,
  parsePipeline,
} from 'playtiss/pipeline/parser'
import promise_map from 'playtiss/utils/promise_map'
import { taskCreationPromiseMap } from '../utils/promise-map-limited.js'
// import { requestElevatedActionToken } from "../graphql/action.js";
import { LRUCache } from 'lru-cache'
import { type TraceId, isTraceId } from 'playtiss/types/trace_id'
import type { PendingTask, Task } from '../graphql/types.js'
import { getLimiter } from '../utils/concurrency-limiter.js'
import {
  type V12Context,
  type V12WorkflowExecutionContext,
  createPendingTaskRecord,
  createTaskRecord,
  deletePendingTask,
  getContextAssetHash,
  getPendingTaskInputs,
  getSharedGraphQLClient,
  getTaskInputs,
  getTaskRecords,
  getWorkflowTaskIdFromRevisionId,
  updateAndRetrieveTaskMergeAsset,
  updateTaskStatus,
} from './model.js'

// ================================================================
// v16 AUTO-PROPAGATION CONFIGURATION
// ================================================================

// When true, downstream nodes are automatically re-executed when upstream changes
// When false (default), downstream nodes are marked STALE and wait for manual update
const AUTO_PROPAGATE_STALE_NODES = process.env.PLAYTISS_AUTO_PROPAGATE === 'true'

// ================================================================
// OPTIMIZED HELPER FUNCTIONS (use singleton GraphQL client)
// ================================================================

/**
 * Cache for V12Context asset loading to avoid redundant S3 load() calls
 *
 * Context asset content is immutable - same assetId always produces same value
 * This cache is critical for onTaskDelivered() performance with high concurrency
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
 * When onTaskDelivered() processes 20 workflow records in parallel,
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
async function writeEventOptimized(
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

function isPipelineOutput(
  node: AssetId | null,
): node is null {
  return node === null
}

async function writePipelineEvent(
  context: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  asset: DictAsset,
  event_type: EventType,
) {
  // write event with the correct worker ID from workflow context
  // If no workerId is provided, writeEventOptimized will use the default 'workflow-engine'
  const pipelineEvent = await writeEventOptimized(
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
  node: AssetId,
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
  return await taskCreationPromiseMap(
    [null], // dummy item to satisfy promise_map_limited
    async () => {
      const task = await createTaskOptimized(actionId, asset)
      await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH')
      return task
    },
    { concurrency: 1 },
  ).then(results => results[0])
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
  node: AssetId,
  asset: DictAsset,
): Promise<Task | null> {
  const actionId = pipelineInfo.nodes[node].action
  if (!isTraceId(actionId)) {
    throw new Error(`built in action ${actionId} is not separate task`)
  }

  // Store inputs as asset (inputs hash = asset ID)
  const limiter = getLimiter('s3-store')
  const inputsAssetId = await limiter(async () => store(asset))

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

    return await taskCreationPromiseMap(
      [null], // dummy item to satisfy promise_map_limited
      async () => {
        const task = await createTaskOptimized(actionId, asset)
        await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH')
        return task
      },
      { concurrency: 1 },
    ).then(results => results[0])
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

    return await taskCreationPromiseMap(
      [null],
      async () => {
        // Create task (GraphQL mutation automatically schedules it as PENDING)
        const task = await createTaskOptimized(actionId, asset)

        // createTaskRecord will:
        // - Set dependencyStatus = "FRESH" (we're processing the input change)
        // - Check TaskExecutionState.runtimeStatus (PENDING) → map to RUNNING
        // - Set requiredTaskId = task.id
        // - Set lastInputsHash = inputsAssetId
        await createTaskRecord(pipeline, context, node, task, workflowContext, inputsAssetId, 'FRESH')

        console.log(`✅ Auto-created task ${task.id} for stale node ${node}`)
        return task
      },
      { concurrency: 1 },
    ).then(results => results[0])
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

function isTagSlot(name: string): name is `%${string}` {
  return name.startsWith('%')
}

// TODO: remove this once we migrate to v12
const taskMergeAction: SystemActionId = 'core:orchestrator.task_merge'

async function accessDictAsset(
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
 * - Second level key: nextNodeId (AssetId) - identifies the merge node
 * - Value: Promise that resolves when the critical zone completes
 *
 * TODO: Consider cleanup of completed workflow revisions to prevent unbounded memory growth.
 * Currently kept for simplicity as the map is bounded by number of concurrent workflows.
 */
const criticalZoneLock = new Map<
  TraceId,
  Map<AssetId, Promise<void>>
>()

async function processNodeSlotInfo(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  { node: nextNodeId, tag_edges, slot_edges }: NodeSlotInfo,
): Promise<Task | PendingTask | (Task | PendingTask)[] | null> {
  // Create a promise to signal when this call's critical zone completes
  // This will be used by other concurrent calls to wait their turn
  // Only needed for merge nodes (nextNodeId !== null) to prevent race conditions
  //
  // Assumption: merge nodes do not trigger recursive calls to processNodeSlotInfo
  // (i.e., processing a merge node doesn't cause the same merge node to be processed again)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  try {
    const nextNode
      = nextNodeId === null
        ? null
        : nextNodeId as AssetId
    const nextNodeType
      = nextNodeId === null
        ? pipelineInfo.output_type
        : pipelineInfo.node_types[nextNodeId]
    const nextNodeSlots
      = nextNodeId === null
        ? pipelineInfo.output_slots
        : pipelineInfo.node_slots[nextNodeId]

    // prepare nextContext
    const nextContext: V12Context = {}
    await promise_map(
      tag_edges,
      async ({ source, target }) => {
        const sourceName = source.name
        const targetName = target.name as `%${string}` // tag_edges contains only tag targets
        // read source from context or asset
        const value = isTagSlot(sourceName)
          ? currentContext[sourceName]
          : await accessDictAsset(currentAsset, sourceName)
        // set value to nextContext
        if (value !== undefined) {
          nextContext[targetName] = value
        }
        else {
          console.warn(`property ${sourceName} does not exist!`)
        }
      },
      { concurrency: 1 },
    )

    // prepare nextAsset
    let nextAsset: DictAsset = {}
    if (nextNodeType === 'merge') {
      // === CRITICAL ZONE FOR MERGE NODES ===
      // Acquire lock to prevent concurrent access to merge node state within same workflow revision
      //
      const revisionId = workflowContext.workflowRevisionId

      // 1. Get or create the lock map for this workflow revision
      let revisionLocks = criticalZoneLock.get(revisionId)
      if (!revisionLocks) {
        revisionLocks = new Map<AssetId, Promise<void>>()
        criticalZoneLock.set(revisionId, revisionLocks)
      }

      // 2. Check if another call in THIS revision is already processing this merge node
      const lock = revisionLocks.get(nextNodeId!)
      // 3. Register our promise so future calls in this revision will wait for us
      revisionLocks.set(nextNodeId!, promise)
      // 4. If there was a previous call, wait for it to complete first
      if (lock) {
        await lock
      }
      // 5. Now we have exclusive access for this revision - read the current merge state
      // obtain inputs on record (either pending or completed task)
      nextAsset
        = (await getPendingTaskInputs(
          pipeline,
          nextContext,
          nextNode,
          workflowContext,
        ))
        || (await getTaskInputs(
          pipeline,
          nextContext,
          nextNode,
          workflowContext,
        ))
        || {}
      // Note: Lock will be released in finally block when promise resolves
    }
    await promise_map(
      slot_edges,
      async ({ source, target }) => {
        const sourceName = source.name
        const targetName = target.name
        // read source from context or asset
        const value = isTagSlot(sourceName)
          ? currentContext[sourceName]
          : await accessDictAsset(currentAsset, sourceName)
        // set value to asset
        if (value !== undefined) {
          nextAsset[targetName] = value
        }
        else {
          console.warn(`property ${sourceName} does not exist!`)
        }
      },
      { concurrency: 1 },
    )

    /// / prepare next task or pending task
    // regular node: no need to wait on other nodes, directly prepare next task
    switch (nextNodeType) {
      case 'regular': {
        // for pipeline output: deliver pipeline task
        if (isPipelineOutput(nextNode)) {
          await writePipelineEvent(
            nextContext,
            workflowContext,
            nextAsset,
            'deliver',
          )
          return null
        }
        // for next internal node: smart task creation (v14)
        else {
          return await processNodeReady(
            pipeline,
            pipelineInfo,
            nextContext,
            workflowContext,
            nextNode,
            nextAsset,
          )
        }
      }
      // for merge node
      case 'merge': {
        // if all inputs are ready
        if (nextNodeSlots.every(name => name in nextAsset)) {
          // delete pending task (if any)
          await deletePendingTask(
            pipeline,
            nextContext,
            nextNode,
            workflowContext,
          )
          // for pipeline output: deliver pipeline task
          if (isPipelineOutput(nextNode)) {
            await writePipelineEvent(
              nextContext,
              workflowContext,
              nextAsset,
              'deliver',
            )
            return null
          }
          // for next internal node: smart task creation (v14)
          else {
            return await processNodeReady(
              pipeline,
              pipelineInfo,
              nextContext,
              workflowContext,
              nextNode,
              nextAsset,
            )
          }
        }
        // if not all inputs are ready, create new pending task
        else {
          const action = isPipelineOutput(nextNode)
            ? (workflowContext.workflowRevisionId as ActionId) // TODO: FIX THIS
            : pipelineInfo.nodes[nextNode!].action
          if (!isTraceId(action)) {
            throw new Error(
              `built in action ${action} does not accept inputs from multiple nodes`,
            )
          }
          const pending_task: PendingTask = {
            asset_type: 'pending_task',
            action,
            input: nextAsset,
            creator: 'workflow-engine',
            timestamp: 0,
          }

          await createPendingTaskRecord(
            pipeline,
            nextContext,
            nextNode,
            nextAsset,
            workflowContext,
          )
          return pending_task
        }
      }
      case 'task_split': {
        if (isPipelineOutput(nextNode)) {
          throw new Error('Output node cannot have builtin action')
        }
        return splitTask(
          pipeline,
          pipelineInfo,
          nextContext,
          workflowContext,
          nextAsset,
          nextNode,
        )
      }
      case 'task_merge': {
        if (isPipelineOutput(nextNode)) {
          throw new Error('Output node cannot have builtin action')
        }
        const keys = nextAsset.keys
        if (typeof keys === 'number') {
          // Array

          const tmpAsset = await updateAndRetrieveTaskMergeAsset(
            pipeline,
            nextContext,
            nextNode,
            (nextAsset.key as number).toFixed(0),
            nextAsset.item,
            workflowContext,
          )

          if (Object.keys(tmpAsset).length === keys) {
            const outputAsset = Array.from(
              { length: keys },
              (_, i) => tmpAsset[i.toFixed(0)],
            )
            return deliverMergeTask(
              pipeline,
              pipelineInfo,
              nextContext,
              workflowContext,
              { output: outputAsset },
              nextNode,
            )
          }
          // if not all inputs are ready, return new pending task
          else {
            const pending_task: PendingTask = {
              asset_type: 'pending_task',
              action: taskMergeAction,
              input: tmpAsset,
              creator: 'workflow-engine',
              timestamp: 0,
            }
            // DO NOT create record since tmpAsset is updated atomically before retrieval
            // await createPendingTaskRecord(nextContext, nextNode, pending_task);
            return pending_task
          }
        }
        if (Array.isArray(keys)) {
          // Object
          const tmpAsset = await updateAndRetrieveTaskMergeAsset(
            pipeline,
            nextContext,
            nextNode,
            nextAsset.key as string,
            nextAsset.item,
            workflowContext,
          )

          if (keys.every(key => typeof key === 'string' && key in tmpAsset)) {
            const outputAsset = tmpAsset
            return deliverMergeTask(
              pipeline,
              pipelineInfo,
              nextContext,
              workflowContext,
              { output: outputAsset },
              nextNode,
            )
          }
          // if not all inputs are ready, return new pending task
          else {
            const pending_task: PendingTask = {
              asset_type: 'pending_task',
              action: taskMergeAction,
              input: tmpAsset,
              creator: 'workflow-engine',
              timestamp: 0,
            }
            // DO NOT create record since tmpAsset is updated atomically before retrieval
            // await createPendingTaskRecord(nextContext, nextNode, pending_task);
            return pending_task
          }
        }
        throw new Error('Invalid keys type')
      }
      case 'const': {
        // Const nodes output their value directly without task execution
        if (isPipelineOutput(nextNode)) {
          throw new Error('Output node cannot be a const node')
        }
        // Get the const value from the node definition
        const nodeData = pipelineInfo.nodes[nextNode!]
        if (!isConstNode(nodeData)) {
          throw new Error(`Node ${nextNode} is marked as const but missing value property`)
        }
        // Single 'output' slot - downstream accesses via 'output' or 'output.key'
        const constOutput: DictAsset = { output: nodeData.value }

        // Propagate const value to downstream nodes
        return flattenTasks(
          await promise_map(
            pipelineInfo.node_nexts[nextNode!],
            async nodeSlotInfo =>
              processNodeSlotInfo(
                pipeline,
                pipelineInfo,
                nextContext,
                workflowContext,
                constOutput,
                nodeSlotInfo,
              ),
            { concurrency: 1 },
          ),
        )
      }
    }
  }
  catch (error) {
    // Reject the promise so any waiting calls are notified of the error
    reject(error)
    // Re-throw to propagate the error up the call stack
    throw error
  }
  finally {
    // Release the lock by resolving the promise
    // This allows the next waiting call (if any) to proceed
    //
    // IMPORTANT: We don't remove the entry from revisionLocks or criticalZoneLock
    // By the time we resolve, another async call may have already:
    // 1. Read our promise from revisionLocks (line 358: const lock = revisionLocks.get(nextNodeId!))
    // 2. Set their own promise (line 360: revisionLocks.set(nextNodeId!, promise))
    // 3. Started waiting on our promise (line 362-364: if (lock) await lock)
    //
    // If we deleted the entry here, we'd delete THEIR lock, not ours!
    // The maps are naturally bounded by:
    // - criticalZoneLock: number of concurrent workflow revisions
    // - revisionLocks: number of unique merge nodes in the pipeline
    resolve()
  }
}

function flattenTasks(
  tasks: (Task | PendingTask | null | (Task | PendingTask | null)[])[],
): (Task | PendingTask)[] {
  return tasks
    .flat()
    .filter((item): item is Task | PendingTask => item !== null)
}

async function splitTask(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  node: AssetId,
): Promise<(Task | PendingTask)[]> {
  const input = await ensureDictOrArrayAsset(
    currentAsset['input'],
  )

  if (Array.isArray(input)) {
    const keys = input.length
    console.log(`🔀 Split input is ARRAY with ${keys} items`)
    return flattenTasks(
      await promise_map(
        input,
        async (item, key) => {
          return flattenTasks(
            await promise_map(
              pipelineInfo.node_nexts[node],
              async nodeSlotInfo =>
                processNodeSlotInfo(
                  pipeline,
                  pipelineInfo,
                  currentContext,
                  workflowContext,
                  { keys, key, item },
                  nodeSlotInfo,
                ),
              { concurrency: 1 },
            ),
          )
        },
        { concurrency: 1 },
      ),
    )
  }
  else {
    const keys = Object.keys(input)
    const entries = Object.entries(input)
    console.log(`🔀 Split input is OBJECT with ${keys.length} keys`)

    try {
      const promiseMapResult = await promise_map(
        entries,
        async ([key, item], entryIndex) => {
          try {
            const nodeResults = await promise_map(
              pipelineInfo.node_nexts[node],
              async (nodeSlotInfo, index) => {
                try {
                  return await processNodeSlotInfo(
                    pipeline,
                    pipelineInfo,
                    currentContext,
                    workflowContext,
                    { keys, key, item },
                    nodeSlotInfo,
                  )
                }
                catch (error) {
                  console.error(
                    `❌ ERROR in processNodeSlotInfo for key ${key}, node ${index + 1}:`,
                    error,
                  )
                  throw error
                }
              },
              { concurrency: 1 },
            )

            return flattenTasks(nodeResults)
          }
          catch (error) {
            console.error(
              `❌ ERROR processing key ${key} (entry ${entryIndex + 1}):`,
              error,
            )
            throw error
          }
        },
        { concurrency: 1 },
      )

      return flattenTasks(promiseMapResult)
    }
    catch (error) {
      console.error(`❌ FATAL ERROR in splitTask promise_map:`, error)
      console.error(`❌ Error stack:`, (error as Error).stack)
      throw error
    }
  }
}

async function deliverMergeTask(
  pipeline: AssetId,
  pipelineInfo: PipelineInfo,
  currentContext: V12Context,
  workflowContext: V12WorkflowExecutionContext,
  currentAsset: DictAsset,
  node: AssetId,
): Promise<(Task | PendingTask)[]> {
  return flattenTasks(
    await promise_map(
      pipelineInfo.node_nexts[node],
      async nodeSlotInfo =>
        processNodeSlotInfo(
          pipeline,
          pipelineInfo,
          currentContext,
          workflowContext,
          currentAsset,
          nodeSlotInfo,
        ),
      { concurrency: 1 },
    ),
  )
}

// on pipeline claimed
// * pass pipeline inputs to nodes
// * process const nodes (source nodes with no incoming edges)
export async function onPipelineClaimed(
  claimEvent: {
    task: Task
    workflowRevisionId: TraceId
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
): Promise<(Task | PendingTask)[]> {
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
  const allResults: (Task | PendingTask)[] = []

  // 1. Process pipeline input connections
  const inputResults = await promise_map(
    pipelineInfo.input_next,
    async (nodeSlotInfo) => {
      return await processNodeSlotInfo(
        pipeline,
        pipelineInfo,
        currentContext,
        workflowContext,
        input,
        nodeSlotInfo,
      )
    },
    { concurrency },
  )
  allResults.push(...flattenTasks(inputResults))

  // 2. Process const nodes (source nodes with no incoming edges)
  // Const nodes need to be initialized here since they have no upstream connections
  const constNodeRefs = Object.entries(pipelineInfo.node_types)
    .filter(([, nodeType]) => nodeType === 'const')
    .map(([nodeRef]) => nodeRef as AssetId)

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
      const constResults = await promise_map(
        nextNodes,
        async (nodeSlotInfo) => {
          return await processNodeSlotInfo(
            pipeline,
            pipelineInfo,
            currentContext,
            workflowContext,
            constOutput,
            nodeSlotInfo,
          )
        },
        { concurrency: 1 },
      )
      allResults.push(...flattenTasks(constResults))
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
export async function onTaskDelivered(
  deliverEvent: {
    task: Task
    output: AssetValue
  },
  pipeline: AssetId,
  concurrency: number = 3,
  workerId: string, // Worker ID for workflow task operations
  workflowRevisionId: TraceId, // current workflow revision ID for this orchestrator
): Promise<(Task | PendingTask)[]> {
  const { task, output: asset } = deliverEvent

  // TODO: remove task from watch list
  // update internal status
  await updateTaskStatus(pipeline, task, 'deliver')
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
  return flattenTasks(
    await promise_map(
      records,
      async ({
        context,
        node,
        workflowRevisionId: recordWorkflowRevisionId, // eslint-disable-line @typescript-eslint/no-unused-vars
      }): Promise<(Task | PendingTask)[]> => {
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

        const results = flattenTasks(
          await promise_map(
            nextNodes,
            async nodeSlotInfo =>
              processNodeSlotInfo(
                pipeline,
                pipelineInfo,
                currentContext,
                workflowContext,
                await ensureDictAsset(asset),
                nodeSlotInfo,
              ),
            { concurrency },
          ),
        )

        if (results.length > 0) {
          console.log(
            `📊 onTaskDelivered returned ${results.length} dependent tasks`,
          )
        }
        return results
      },
      { concurrency: 20 }, // Process workflow records in parallel (typical: 19-20 records)
    ),
  )
}

// on task aborted
export async function onTaskAborted(
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
      `📦 onTaskDelivered received asset with ${orderKeys.length} orders: [${orderKeys.slice(0, 5).join(', ')}${orderKeys.length > 5 ? ', ...' : ''}]`,
    )
  }
  // TODO: remove task from watch list
  // update internal status
  await updateTaskStatus(pipeline, task, 'abort')

  // find all context and abort (filtered server-side)
  // TODO: abort other internal subtasks as well?
  const records = await getTaskRecords(pipeline, task, workflowRevisionId)
  if (records.length === 0) {
    console.warn(`❌ No records found for workflow revision ${workflowRevisionId}`)
    return
  }
  await promise_map(
    records,
    async ({ context, node, workflowRevisionId }) => {
      const currentContext = await toValueCachedContext(context)

      // Find the workflow task ID from the workflow revision ID
      const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflowRevisionId)
      if (!workflowTaskId) {
        console.error(
          `❌ Could not find workflow task ID for revision ${workflowRevisionId} in onTaskAborted`,
        )
        return
      }

      // Construct workflow execution context per record
      const workflowContext: V12WorkflowExecutionContext = {
        workflowTaskId: workflowTaskId,
        workflowRevisionId: workflowRevisionId,
        workerId: workerId,
      }

      await writePipelineEvent(
        currentContext,
        workflowContext,
        {
          node,
          ...asset,
        },
        'abort',
      )
    },
    { concurrency },
  )
}

export async function onTaskUpdated(
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
  // update internal status
  await updateTaskStatus(pipeline, task, 'update')

  // find all context and update (filtered server-side)
  const records = await getTaskRecords(pipeline, task, workflowRevisionId)
  if (records.length === 0) {
    console.warn(`❌ No records found for workflow revision ${workflowRevisionId}`)
    return
  }

  await promise_map(
    records,
    async ({ context, node, workflowRevisionId }) => {
      const currentContext = await toValueCachedContext(context)

      // Find the workflow task ID from the workflow revision ID
      const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflowRevisionId)
      if (!workflowTaskId) {
        console.error(
          `❌ Could not find workflow task ID for revision ${workflowRevisionId} in onTaskUpdated`,
        )
        return
      }

      // Construct workflow execution context per record
      const workflowContext: V12WorkflowExecutionContext = {
        workflowTaskId: workflowTaskId,
        workflowRevisionId: workflowRevisionId,
        workerId: workerId,
      }

      await writePipelineEvent(
        currentContext,
        workflowContext,
        {
          node,
          ...asset,
        },
        'update',
      )
    },
    { concurrency },
  )
}

// on task created
// TODO: add task to watch list
// export async function onTaskCreated(
//   createEvent: Event<"create">,
//   pipeline: Pipeline,
// ) {
// }
