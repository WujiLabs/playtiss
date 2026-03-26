// Copyright (c) 2026 Wuji Labs Inc
/**
 * Task Runner for TypeScript Worker
 *
 * Handles task claiming, execution, and result reporting using p-limit
 * for concurrency control and a Set for deduplication tracking.
 */
import pLimit from 'p-limit'
import type { ActionId, AssetId, DictAsset, TraceId } from 'playtiss'
import { load, store } from 'playtiss/asset-store'

import { GraphQLClient } from './graphql-client.js'
import { type TaskInfo, TaskIterator } from './task-iterator.js'

// Type for tracking lease-expired tasks
type LeaseExpiredTask = {
  info: TaskInfo
  lastAttempt: number
}

export interface RunnerContext {
  taskId: string
  update: ProgressUpdateType
}

export type ProgressUpdateType = (asset: DictAsset) => Promise<void>
export type CallbackType = (input: DictAsset, context: RunnerContext) => Promise<DictAsset>

/**
 * Store asset with enhanced error handling and context
 */
function safeStore(asset: DictAsset, context: string = 'asset'): Promise<AssetId> {
  try {
    console.debug(`Storing ${context}:`, typeof asset)
    const assetHash = store(asset)
    console.debug(`Successfully stored ${context}:`, assetHash)
    return assetHash
  }
  catch (error) {
    console.error(`Failed to store ${context}:`, error)
    throw new Error(`Asset storage failed for ${context}: ${error}`)
  }
}

/**
 * Read task input from asset store via GraphQL
 */
async function readTaskInput(taskId: string, client: GraphQLClient): Promise<DictAsset | null> {
  console.info(`Attempting to read task input for ${taskId}`)

  const task = await client.getTask(taskId as TraceId)
  if (!task) {
    console.error(`Task ${taskId} not found in GraphQL`)
    return null
  }

  const inputsContentHash = task.inputsContentHash
  if (!inputsContentHash) {
    console.error(`No inputsContentHash found for task ${taskId}`)
    return null
  }

  console.info(`Found inputsContentHash from GraphQL: ${inputsContentHash}`)

  try {
    const inputData = await load(inputsContentHash as AssetId)
    if (typeof inputData === 'object' && inputData !== null && !Array.isArray(inputData) && !(inputData instanceof Uint8Array)) {
      return inputData as DictAsset
    }
    console.error(`Input data is not a dict: ${typeof inputData}`, inputData)
    return null
  }
  catch (error) {
    console.error(`Failed to load input asset for task ${taskId}:`, error)
    return null
  }
}

/**
 * Get future timestamp in milliseconds
 */
function getFutureTimestamp(ttlSec: number): number {
  return Date.now() + (ttlSec * 1000)
}

/**
 * Check if an error message indicates a lease expiration
 */
function isLeaseExpiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('lease may have expired') || msg.includes('not owned by worker')
}

/**
 * Execute a claimed task: read input, run callback, store output, report result.
 * Linear async flow without nested try/catch blocks.
 */
export async function executeTask(
  client: GraphQLClient,
  taskInfo: TaskInfo,
  execute: CallbackType,
  options: {
    taskIterator?: TaskIterator
    testRun?: boolean
    timeoutInterval?: number
    workerId?: string
    isRetry?: boolean
  },
): Promise<void> {
  const {
    taskIterator,
    testRun = false,
    timeoutInterval,
    workerId = 'anonymous',
    isRetry = false,
  } = options

  const taskId = taskInfo.taskId

  // Step 1: Claim the task (unless test run or retry)
  if (!testRun && !isRetry) {
    console.info(`Attempting to claim task ${taskId}`)
    const claimedState = await client.claimTask({
      taskId: taskId as TraceId,
      workerId,
      ttl: timeoutInterval || 300,
    })
    if (claimedState === null) {
      console.debug(`Could not claim task ${taskId} - already claimed or no longer PENDING`)
      taskIterator?.markTaskCompleted(taskId)
      return
    }
    console.info(`Successfully claimed task ${taskId}`)
  }
  else if (isRetry) {
    console.info(`Processing reclaimed task ${taskId}`)
  }

  // Step 2: Read task input
  const inputAsset = await readTaskInput(taskId, client)
  if (inputAsset === null) {
    throw new Error('input asset not valid')
  }

  // Step 3: Execute the task
  let outputAsset: DictAsset | null = null
  let success = true

  try {
    const updateCallback: ProgressUpdateType = async (asset: DictAsset) => {
      if (timeoutInterval !== undefined) {
        asset = { ...asset }
        asset.worker_report_timeout = getFutureTimestamp(timeoutInterval)
      }
      if (!testRun) {
        // TODO (Phase 2+): Implement PROGRESS version type for task progress reporting
        console.debug(`Progress update for task ${taskId} (not persisted in Phase 1)`)
      }
    }

    outputAsset = await execute(inputAsset, { taskId, update: updateCallback })
    console.info(`Task ${taskId} execution completed with output:`, outputAsset)
  }
  catch (err) {
    console.error(`Task ${taskId} execution failed:`, err)
    success = false
    if (err instanceof Error && 'output' in err && typeof err.output === 'object') {
      outputAsset = err.output as (DictAsset | null)
    }
    else {
      outputAsset = {
        error: err instanceof Error ? err.message : String(err),
        error_type: err instanceof Error ? err.constructor.name : 'UnknownError',
      }
    }
  }

  if (testRun) {
    console.info(`Test run - Task ${taskId}: input=${JSON.stringify(inputAsset)}, output=${JSON.stringify(outputAsset)}`)
    return
  }

  // Step 4: Store result and report
  if (outputAsset === null) {
    outputAsset = { error: 'No output produced', error_type: 'NoOutputError' }
    success = false
  }

  const assetHash = await safeStore(outputAsset, success ? 'task result' : 'error result')
  const versionType = success ? 'OUTPUT' : 'ERROR'
  const version = await client.createVersion({
    taskId: taskId as TraceId,
    versionType,
    assetContentHash: assetHash,
    commitMessage: success ? 'Task completion' : 'Task failed',
  })

  try {
    if (success) {
      await client.reportTaskSuccess({ taskId: taskId as TraceId, workerId, resultVersionId: version.id })
      console.info(`Task ${taskId} completed successfully`)
    }
    else {
      await client.reportTaskFailure({ taskId: taskId as TraceId, workerId, errorVersionId: version.id })
      console.info(`Task ${taskId} failed`)
    }
    taskIterator?.markTaskCompleted(taskId)
  }
  catch (reportError) {
    if (isLeaseExpiredError(reportError)) {
      console.error(`⚠️  Cannot deliver task result for ${taskId}: Worker lease expired. Task will be rescheduled by another worker.`)
      taskIterator?.markTaskCompleted(taskId)
      return
    }
    throw reportError
  }
}

/**
 * Main task runner loop using p-limit for concurrency and Set for dedup
 */
export async function runWorkerLoop(
  actionId: ActionId,
  execute: CallbackType,
  options: {
    workerId?: string
    authToken?: string
    concurrency?: number
    testRun?: boolean
    pollInterval?: number
    batchSize?: number
    timeoutInterval?: number
    graphqlUrl?: string
  } = {},
): Promise<void> {
  const {
    workerId,
    authToken,
    concurrency = 1,
    testRun = false,
    pollInterval = 5000,
    batchSize = 10,
    timeoutInterval,
    graphqlUrl = process.env.PLAYTISS_GRAPHQL_URL || 'http://localhost:4000/graphql',
  } = options

  // Create GraphQL client
  const headers: Record<string, string> = {}
  if (workerId) headers['X-Worker-Id'] = workerId
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`
  const client = new GraphQLClient(graphqlUrl, headers)

  // Concurrency control via p-limit and dedup via Set
  const taskLimit = pLimit(concurrency)
  const activeTasks = new Set<string>()
  const leaseExpiredTasks = new Map<string, LeaseExpiredTask>()
  const taskIterator = new TaskIterator(client, actionId, { pollInterval, batchSize })

  // Periodic retry of lease-expired tasks
  let lastRetryTime = Date.now()
  const retryInterval = 30000

  try {
    for await (const taskInfo of taskIterator) {
      // Check if we should retry any lease-expired tasks
      const now = Date.now()
      if (now - lastRetryTime > retryInterval && leaseExpiredTasks.size > 0) {
        lastRetryTime = now
        console.info(`Checking ${leaseExpiredTasks.size} lease-expired tasks for retry...`)

        for (const [expiredTaskId, expiredData] of leaseExpiredTasks) {
          if (activeTasks.has(expiredTaskId)) continue

          console.info(`Attempting to reclaim lease-expired task ${expiredTaskId}`)
          const claimedState = await client.claimTask({
            taskId: expiredTaskId as TraceId,
            workerId: workerId!,
            ttl: timeoutInterval || 300,
          })

          if (claimedState === null) {
            const task = await client.getTask(expiredTaskId as TraceId)
            if (task?.currentVersion) {
              const versionType = task.currentVersion.type
              if (versionType === 'OUTPUT' || versionType === 'ERROR') {
                console.info(`Task ${expiredTaskId} already ${versionType === 'OUTPUT' ? 'SUCCEEDED' : 'FAILED'}, removing from retry list`)
                leaseExpiredTasks.delete(expiredTaskId)
                continue
              }
            }
            console.debug(`Task ${expiredTaskId} still being processed by another worker`)
          }
          else {
            console.info(`Successfully reclaimed task ${expiredTaskId}`)
            leaseExpiredTasks.delete(expiredTaskId)

            activeTasks.add(expiredTaskId)
            taskLimit(() =>
              executeTask(client, expiredData.info, execute, {
                testRun, timeoutInterval, taskIterator, workerId, isRetry: true,
              }).finally(() => activeTasks.delete(expiredTaskId)),
            )
          }
        }
      }

      const taskId = taskInfo.taskId

      // Skip if already being processed
      if (activeTasks.has(taskId)) continue

      console.info(`Processing task ${taskId} for action ${actionId}`)

      activeTasks.add(taskId)
      taskLimit(() =>
        executeTask(client, taskInfo, execute, {
          testRun, timeoutInterval, taskIterator, workerId,
        }).finally(() => activeTasks.delete(taskId)),
      )
    }
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.info('Task runner interrupted by user')
    }
    else {
      console.error('Task runner error:', error)
      throw error
    }
  }
  finally {
    taskIterator.stop()
    await client.close()
    console.info('Task runner stopped')
  }
}

type ExecuteSingleTaskOptions = {
  timeoutInterval?: number
  forceReclaim?: boolean
} & (
  | {
    graphqlClient: GraphQLClient
  }
  | {
    workerId?: string
    authToken?: string
    graphqlUrl?: string
  }
)

/**
 * Execute a single specific task (for testing or manual execution)
 */
export async function executeSingleTask(
  taskId: TraceId,
  execute: CallbackType,
  options: ExecuteSingleTaskOptions = { workerId: undefined },
): Promise<void> {
  const {
    timeoutInterval,
    forceReclaim = false,
  } = options

  let client: GraphQLClient
  let workerId: string
  let shouldCloseClient = false

  if ('graphqlClient' in options) {
    client = options.graphqlClient
    workerId = client.workerId || `ts-mandatory-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
  }
  else {
    const {
      authToken,
      graphqlUrl = process.env.PLAYTISS_GRAPHQL_URL || 'http://localhost:4000/graphql',
      workerId: providedWorkerId,
    } = options
    workerId = providedWorkerId || `ts-mandatory-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const headers: Record<string, string> = {}
    if (workerId) headers['X-Worker-Id'] = workerId
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    client = new GraphQLClient(graphqlUrl, headers)
    shouldCloseClient = true
  }

  try {
    // Read input
    const inputAsset = await readTaskInput(taskId, client)
    if (inputAsset === null) {
      throw new Error('input asset not valid')
    }

    // Claim the task
    if (forceReclaim) {
      console.info(`Force reclaim requested for task ${taskId}`)
      const claimedState = await client.claimTask({
        taskId: taskId as TraceId,
        workerId,
        ttl: timeoutInterval || 600,
      })
      if (claimedState === null) {
        console.warn(`Force reclaim: Task ${taskId} is currently claimed by another worker, proceeding anyway`)
        console.warn('Note: This may cause conflicts if the other worker is still active')
      }
      else {
        console.info(`Force reclaim: Successfully claimed task ${taskId} normally`)
      }
    }
    else {
      const claimedState = await client.claimTask({
        taskId: taskId as TraceId,
        workerId,
        ttl: timeoutInterval || 600,
      })
      if (claimedState === null) {
        throw new Error('Task could not be claimed - it may be already claimed by another worker or completed')
      }
      console.info(`Successfully claimed task ${taskId}`)
    }

    // Execute
    let outputAsset: DictAsset | null = null
    let success = true

    try {
      const updateCallback: ProgressUpdateType = async (asset: DictAsset) => {
        if (timeoutInterval !== undefined) {
          asset = { ...asset }
          asset.worker_report_timeout = getFutureTimestamp(timeoutInterval)
        }
        console.debug(`Progress update for mandatory task ${taskId} (not persisted in Phase 1)`)
      }
      outputAsset = await execute(inputAsset, { taskId, update: updateCallback })
    }
    catch (err) {
      console.error(`Mandatory task execution failed:`, err)
      success = false
      if (err instanceof Error && 'output' in err && typeof err.output === 'object') {
        outputAsset = err.output as (DictAsset | null)
      }
      else {
        outputAsset = {
          error: err instanceof Error ? err.message : String(err),
          error_type: err instanceof Error ? err.constructor.name : 'UnknownError',
        }
      }
    }

    // Store and report
    const assetHash = await safeStore(outputAsset || {}, 'mandatory task result')
    const versionType = success ? 'OUTPUT' : 'ERROR'
    const version = await client.createVersion({
      taskId,
      versionType,
      assetContentHash: assetHash,
      commitMessage: success ? 'Mandatory task completion' : 'Mandatory task failed',
    })

    try {
      if (success) {
        await client.reportTaskSuccess({ taskId, workerId, resultVersionId: version.id })
        console.info(`Mandatory task ${taskId} completed successfully`)
      }
      else {
        await client.reportTaskFailure({ taskId, workerId, errorVersionId: version.id })
        console.info(`Mandatory task ${taskId} failed`)
      }
    }
    catch (reportError) {
      if (isLeaseExpiredError(reportError)) {
        console.error(`⚠️  Cannot report mandatory task completion for ${taskId}: Worker lease expired. Task will be rescheduled.`)
        return
      }
      throw reportError
    }
  }
  catch (error) {
    if (isLeaseExpiredError(error)) {
      console.error(`⚠️  Cannot complete mandatory task ${taskId}: Worker lease expired or invalid. Task will be rescheduled by another worker.`)
      return
    }
    console.error(`Error in mandatory task runner:`, error)
    throw error
  }
  finally {
    if (shouldCloseClient) {
      await client.close()
    }
  }
}
