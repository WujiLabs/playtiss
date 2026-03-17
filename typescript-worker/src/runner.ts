// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
/**
 * Task Runner for TypeScript Worker
 *
 * This module provides the main task execution logic, similar to the Python
 * playtiss-action-runner runner.py implementation. It handles task claiming,
 * execution, and result reporting.
 */
import type { ActionId, CompoundAssetId, Creator, DictLazyAsset, TraceId } from 'playtiss'
import { isCompoundAssetId, isReference, toAssetId } from 'playtiss'
import { load, store } from 'playtiss/asset-store'
import { GraphQLClient } from './graphql-client.js'
import { TaskIterator, type TaskInfo } from './task-iterator.js'

// Type for tracking lease-expired tasks
type LeaseExpiredTask = {
  info: TaskInfo
  lastAttempt: number
}

export interface RunnerContext {
  taskId: string
  update: ProgressUpdateType
  getCreator: FetchCreatorType
  getCreatorId: FetchCreatorIdType
}

export type ProgressUpdateType = (asset: DictLazyAsset) => Promise<void>
export type FetchCreatorType = () => Promise<Creator | null>
export type FetchCreatorIdType = () => Promise<string | null>
export type CallbackType = (input: DictLazyAsset, context: RunnerContext) => Promise<DictLazyAsset>

/**
 * Store asset with enhanced error handling and context
 */
function safeStore(asset: DictLazyAsset, context: string = 'asset'): Promise<CompoundAssetId> {
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
async function readTaskInput(taskId: string, client: GraphQLClient): Promise<DictLazyAsset | null> {
  console.info(`Attempting to read task input for ${taskId}`)

  try {
    // Get task details from GraphQL to find inputs_content_hash
    console.info(`Getting task details via GraphQL for ${taskId}`)
    const task = await client.getTask(taskId as TraceId)
    console.info(`Task details:`, task)

    if (!task) {
      console.error(`Task ${taskId} not found in GraphQL`)
      return null
    }

    // Extract inputs_content_hash from GraphQL response
    const inputsContentHash = task.inputsContentHash
    if (!inputsContentHash) {
      console.error(`No inputsContentHash found for task ${taskId}`)
      return null
    }

    console.info(`Found inputsContentHash from GraphQL: ${inputsContentHash}`)

    // Load the actual input asset
    const assetId = `@${inputsContentHash}`
    console.info(`Loading input asset: ${assetId}`)

    if (!isCompoundAssetId(assetId)) {
      console.error(`Invalid compound asset ID format: ${assetId}`)
      return null
    }

    try {
      const inputData = await load(assetId as CompoundAssetId)
      console.info(`Loaded input data:`, inputData)

      if (typeof inputData === 'object' && inputData !== null && !Array.isArray(inputData) && !(inputData instanceof Uint8Array)) {
        return inputData as DictLazyAsset
      }
      else {
        console.error(`Input data is not a dict: ${typeof inputData}`, inputData)
        return null
      }
    }
    catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found') || error.message.includes('ENOENT')) {
          console.error(`Input asset not found:`, error)
        }
        else if (error.message.includes('permission') || error.message.includes('EACCES')) {
          console.error(`Permission denied loading input asset:`, error)
        }
        else {
          console.error(`Failed to load input asset:`, error)
        }
      }
      else {
        console.error(`Failed to load input asset:`, error)
      }
      return null
    }
  }
  catch (error) {
    console.error(`Error reading task input for ${taskId}:`, error)
    return null
  }
}

/**
 * Read task creator from graphql server
 */
async function readTaskCreator(taskId: TraceId, client: GraphQLClient): Promise<Creator | null> {
  try {
    const task = await client.getTask(taskId)
    if (task && 'creator' in task) {
      return task.creator as Creator
    }
  }
  catch (error) {
    console.error(`Error reading task creator for ${taskId}:`, error)
  }
  return null
}

/**
 * Compute task creator string representation
 */
async function computeTaskCreatorStr(taskId: TraceId, client: GraphQLClient): Promise<string | null> {
  const creator = await readTaskCreator(taskId, client)
  if (creator === null) {
    return null
  }
  if (isReference(creator)) {
    return creator.ref
  }
  if (typeof creator === 'string') {
    return `"${creator}"` // escape by double quoting
  }
  return await store(creator)
}

/**
 * Task Pool for managing concurrent task execution
 */
export class TaskPool {
  private concurrency: number | null
  private tasks = new Set<Promise<void>>()
  private taskKeys = new Set<string>()

  constructor(concurrency: number | null = null) {
    this.concurrency = concurrency
  }

  contains(key: string): boolean {
    return this.taskKeys.has(key)
  }

  isAvailable(): boolean {
    return this.concurrency === null || this.tasks.size < this.concurrency
  }

  async waitTillAvailable(): Promise<void> {
    while (!this.isAvailable()) {
      // Wait for some tasks to finish before adding a new one
      await Promise.race(this.tasks)
    }
  }

  add(key: string, task: Promise<void>): void {
    const wrappedTask = task.finally(() => {
      this.tasks.delete(wrappedTask)
      this.taskKeys.delete(key)
    })

    this.taskKeys.add(key)
    this.tasks.add(wrappedTask)
  }

  addNewResolver(key: string): () => void {
    let resolve: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })

    this.add(key, promise)

    return () => resolve()
  }
}

/**
 * Get future timestamp in milliseconds
 */
function getFutureTimestamp(ttlSec: number): number {
  return Date.now() + (ttlSec * 1000)
}

/**
 * Handle execution of a single task using v3.1 GraphQL API
 */
export async function handleNewTask(
  client: GraphQLClient,
  taskInfo: TaskInfo,
  execute: CallbackType,
  options: {
    pendingTaskpool: TaskPool
    taskIterator?: TaskIterator
    testRun?: boolean
    timeoutInterval?: number
    workerId?: string
    leaseExpiredTasks?: Map<string, LeaseExpiredTask>
    isRetry?: boolean
  },
): Promise<void> {
  const {
    pendingTaskpool,
    taskIterator,
    testRun = false,
    timeoutInterval,
    workerId = 'anonymous',
    leaseExpiredTasks,
    isRetry = false,
  } = options

  const taskId = taskInfo.taskId
  let resolver: (() => void) | null = null

  const getCreator = async () => await readTaskCreator(taskId, client)
  const getCreatorId = async () => await computeTaskCreatorStr(taskId, client)

  // Get a slot in the task pool
  await pendingTaskpool.waitTillAvailable()
  resolver = pendingTaskpool.addNewResolver(taskId)

  try {
    if (!testRun && !isRetry) {
      // Try to claim the task (skip if it's a retry - already claimed in retry loop)
      console.info(`Attempting to claim task ${taskId}`)
      const claimedState = await client.claimTask({
        taskId: taskId as TraceId,
        workerId,
        ttl: timeoutInterval || 300,
      })

      if (claimedState === null) {
        console.debug(`Could not claim task ${taskId} - already claimed or no longer PENDING`)
        // Task is no longer PENDING, remove from retry set
        if (taskIterator) {
          taskIterator.markTaskCompleted(taskId)
        }
        return
      }

      console.info(`Successfully claimed task ${taskId}`)
    }
    else if (isRetry) {
      console.info(`Processing reclaimed task ${taskId}`)
    }

    // Read task input
    console.info(`Reading task input for ${taskId}`)
    const inputAsset = await readTaskInput(taskId, client)
    console.info(`Task input loaded:`, inputAsset)
    if (inputAsset === null) {
      throw new Error('input asset not valid')
    }

    let outputAsset: DictLazyAsset | null = null
    let success = true

    try {
      // Progress update callback
      const updateCallback: ProgressUpdateType = async (asset: DictLazyAsset) => {
        if (timeoutInterval !== undefined) {
          asset = { ...asset }
          asset.worker_report_timeout = getFutureTimestamp(timeoutInterval)
        }

        if (!testRun) {
          // TODO (Phase 2+): Implement PROGRESS version type for task progress reporting
          // Currently disabled in Phase 1 to avoid generating too many short-lived records
          // without CAS garbage collection. Will be re-enabled when we have proper GC.
          console.debug(`Progress update for task ${taskId} (not persisted in Phase 1)`)
        }
      }

      // Execute the task
      console.info(`Executing task ${taskId} with execute function`)
      console.info(`Input data:`, inputAsset)
      outputAsset = await execute(
        inputAsset,
        { taskId, update: updateCallback, getCreator, getCreatorId },
      )
      console.info(`Task ${taskId} execution completed with output:`, outputAsset)
    }
    catch (err) {
      console.error(`Task ${taskId} execution failed:`, err)
      success = false

      // Store error information if provided
      if (err instanceof Error && 'output' in err && typeof err.output === 'object') {
        outputAsset = err.output as (DictLazyAsset | null)
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

    // Store final result and create version
    console.info(`Storing final result for task ${taskId}, success=${success}`)
    if (outputAsset !== null) {
      console.info(`Storing output asset:`, outputAsset)
      const assetHash = await safeStore(outputAsset, 'task result')
      console.info(`Output asset stored with hash: ${assetHash}`)

      const versionType = success ? 'OUTPUT' : 'ERROR'
      console.info(`Creating version of type ${versionType}`)

      const version = await client.createVersion({
        taskId: taskId as TraceId,
        versionType,
        assetContentHash: toAssetId(assetHash),
        commitMessage: success ? 'Task completion' : 'Task failed',
      })
      console.info(`Version created:`, version)

      // Report task completion
      try {
        if (success) {
          console.info(`Reporting task success for ${taskId}`)
          await client.reportTaskSuccess({
            taskId: taskId as TraceId,
            workerId,
            resultVersionId: version.id,
          })
          console.info(`Task ${taskId} completed successfully`)
          // Task completed, remove from retry set
          if (taskIterator) {
            taskIterator.markTaskCompleted(taskId)
          }
        }
        else {
          console.info(`Reporting task failure for ${taskId}`)
          await client.reportTaskFailure({
            taskId: taskId as TraceId,
            workerId,
            errorVersionId: version.id,
          })
          console.info(`Task ${taskId} failed`)
          // Task failed, remove from retry set
          if (taskIterator) {
            taskIterator.markTaskCompleted(taskId)
          }
        }
      }
      catch (reportError) {
        const reportErrMessage = reportError instanceof Error ? reportError.message : String(reportError)
        if (reportErrMessage.includes('lease may have expired') || reportErrMessage.includes('not owned by worker')) {
          console.error(`⚠️  Cannot deliver task result for ${taskId}: Worker lease expired. Task will be rescheduled by another worker.`)
          // Mark task as completed to remove from retry set
          if (taskIterator) {
            taskIterator.markTaskCompleted(taskId)
          }
          return // Gracefully exit without throwing
        }
        throw reportError // Re-throw non-lease errors
      }
    }
    else {
      // No output - report failure
      const errorAsset: DictLazyAsset = {
        error: 'No output produced',
        error_type: 'NoOutputError',
      }
      const assetHash = await safeStore(errorAsset, 'error (no output)')
      const version = await client.createVersion({
        taskId: taskId as TraceId,
        versionType: 'ERROR',
        assetContentHash: toAssetId(assetHash),
        commitMessage: 'Task failed - no output',
      })

      try {
        await client.reportTaskFailure({
          taskId: taskId as TraceId,
          workerId,
          errorVersionId: version.id,
        })
        console.info(`Task ${taskId} failed - no output`)
        // Task failed, remove from retry set
        if (taskIterator) {
          taskIterator.markTaskCompleted(taskId)
        }
      }
      catch (reportError) {
        const reportErrMessage = reportError instanceof Error ? reportError.message : String(reportError)
        if (reportErrMessage.includes('lease may have expired') || reportErrMessage.includes('not owned by worker')) {
          console.error(`⚠️  Cannot report task failure for ${taskId}: Worker lease expired. Task will be retried later.`)
          // Add to lease-expired tasks for retry
          if (leaseExpiredTasks) {
            leaseExpiredTasks.set(taskId, { info: taskInfo, lastAttempt: Date.now() })
          }
          return // Gracefully exit without throwing
        }
        throw reportError // Re-throw non-lease errors
      }
    }
  }
  catch (error) {
    // Check for lease expiration errors and handle gracefully
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('lease may have expired') || errorMessage.includes('not owned by worker')) {
      console.error(`⚠️  Cannot deliver task result for ${taskId}: Worker lease expired or invalid. Task will be rescheduled by another worker.`)
      // Mark task as completed to remove from retry set (another worker will handle it)
      if (taskIterator) {
        taskIterator.markTaskCompleted(taskId)
      }
      return // Gracefully exit without throwing
    }

    console.error(`Error handling task ${taskId}:`, error)

    // Try to report failure if we have a client
    if (!testRun) {
      try {
        const errorAsset: DictLazyAsset = {
          error: error instanceof Error ? error.message : String(error),
          error_type: error instanceof Error ? error.constructor.name : 'UnknownError',
        }
        const assetHash = await safeStore(errorAsset, 'error (exception)')
        const version = await client.createVersion({
          taskId: taskId as TraceId,
          versionType: 'ERROR',
          assetContentHash: toAssetId(assetHash),
          commitMessage: 'Task handler error',
        })

        await client.reportTaskFailure({
          taskId: taskId as TraceId,
          workerId,
          errorVersionId: version.id,
        })
      }
      catch (reportErr) {
        const reportErrMessage = reportErr instanceof Error ? reportErr.message : String(reportErr)
        if (reportErrMessage.includes('lease may have expired') || reportErrMessage.includes('not owned by worker')) {
          console.error(`⚠️  Cannot report task failure for ${taskId}: Worker lease expired. Task will be retried later.`)
          // Add to lease-expired tasks for retry
          if (leaseExpiredTasks) {
            leaseExpiredTasks.set(taskId, { info: taskInfo, lastAttempt: Date.now() })
          }
          return // Gracefully exit without throwing
        }
        console.error(`Could not report task failure:`, reportErr)
      }
    }
    throw error
  }
  finally {
    if (resolver !== null) {
      resolver()
    }
  }
}

/**
 * Main task runner using v3.1 GraphQL API and cursor-based pagination
 */
export async function taskRunner(
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

  const allTasks = new TaskPool()
  const pendingTasks = new TaskPool(concurrency)
  const leaseExpiredTasks = new Map<string, LeaseExpiredTask>() // Track tasks with expired leases
  const taskIterator = new TaskIterator(client, actionId, {
    pollInterval,
    batchSize,
  })

  // Periodic retry of lease-expired tasks
  let lastRetryTime = Date.now()
  const retryInterval = 30000 // Retry lease-expired tasks every 30 seconds

  try {
    for await (const taskInfo of taskIterator) {
      // First, check if we should retry any lease-expired tasks
      const now = Date.now()
      if (now - lastRetryTime > retryInterval && leaseExpiredTasks.size > 0) {
        lastRetryTime = now
        console.info(`Checking ${leaseExpiredTasks.size} lease-expired tasks for retry...`)

        for (const [expiredTaskId, expiredData] of leaseExpiredTasks) {
          // Skip if task is still being processed
          if (allTasks.contains(expiredTaskId)) {
            continue
          }

          // Try to reclaim the task
          console.info(`Attempting to reclaim lease-expired task ${expiredTaskId}`)
          const claimedState = await client.claimTask({
            taskId: expiredTaskId as TraceId,
            workerId: workerId!,
            ttl: timeoutInterval || 300,
          })

          if (claimedState === null) {
            console.debug(`Could not reclaim task ${expiredTaskId} - checking status...`)
            // Get task status to see if it's already completed
            const task = await client.getTask(expiredTaskId as TraceId)
            if (task && task.currentVersion) {
              // Derive runtime status from currentVersion.type
              const versionType = task.currentVersion.type
              if (versionType === 'OUTPUT' || versionType === 'ERROR') {
                const status = versionType === 'OUTPUT' ? 'SUCCEEDED' : 'FAILED'
                console.info(`Task ${expiredTaskId} already ${status}, removing from retry list`)
                leaseExpiredTasks.delete(expiredTaskId)
                continue
              }
            }
            // Task is still running or pending, keep monitoring
            console.debug(`Task ${expiredTaskId} still being processed by another worker`)
          }
          else {
            // Successfully reclaimed! Process it again
            console.info(`Successfully reclaimed task ${expiredTaskId}`)
            leaseExpiredTasks.delete(expiredTaskId)

            const retryPromise = handleNewTask(client, expiredData.info, execute, {
              testRun,
              timeoutInterval,
              pendingTaskpool: pendingTasks,
              taskIterator,
              workerId,
              leaseExpiredTasks,
              isRetry: true,
            })

            allTasks.add(expiredTaskId, retryPromise)
          }
        }
      }

      const taskId = taskInfo.taskId

      // Avoid reclaim if one task is updated but not delivered
      // during the polling interval
      if (allTasks.contains(taskId)) {
        continue
      }

      console.info(`Processing task ${taskId} for action ${actionId}`)

      const taskPromise = handleNewTask(client, taskInfo, execute, {
        testRun,
        timeoutInterval,
        pendingTaskpool: pendingTasks,
        taskIterator,
        workerId,
        leaseExpiredTasks,
      })

      allTasks.add(taskId, taskPromise)
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
    // Stop the iterator
    taskIterator.stop()
    await client.close()
    console.info('Task runner stopped')
  }
}

type MandatoryTaskRunnerOptions = {
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
export async function mandatoryTaskRunner(
  taskId: TraceId,
  execute: CallbackType,
  options: MandatoryTaskRunnerOptions = { workerId: undefined },
): Promise<void> {
  const {
    timeoutInterval,
    forceReclaim = false,
  } = options

  // Use provided client or create a new one
  let client: GraphQLClient
  let workerId: string
  let shouldCloseClient = false

  if ('graphqlClient' in options) {
    client = options.graphqlClient
    // Extract workerId from client to ensure consistency
    workerId = client.workerId || `ts-mandatory-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
  }
  else {
    const {
      authToken,
      graphqlUrl = process.env.PLAYTISS_GRAPHQL_URL || 'http://localhost:4000/graphql',
      workerId: providedWorkerId,
    } = options

    // Generate unique worker ID if not provided
    workerId = providedWorkerId || `ts-mandatory-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    const headers: Record<string, string> = {}
    if (workerId) headers['X-Worker-Id'] = workerId
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`

    client = new GraphQLClient(graphqlUrl, headers)
    shouldCloseClient = true
  }

  try {
    const inputAsset = await readTaskInput(taskId, client)
    if (inputAsset === null) {
      throw new Error('input asset not valid')
    }

    const getCreator = async () => await readTaskCreator(taskId, client)
    const getCreatorId = async () => await computeTaskCreatorStr(taskId, client)

    // Try to claim the task
    if (forceReclaim) {
      console.info(`Force reclaim requested for task ${taskId}`)

      // First, try normal claim (works if task is PENDING or has expired claim)
      const claimedState = await client.claimTask({
        taskId: taskId as TraceId,
        workerId,
        ttl: timeoutInterval || 600, // 10 minutes default
      })

      if (claimedState === null) {
        // Normal claim failed, which means task is actively claimed by another worker
        // For force_reclaim, we'll proceed anyway with a warning
        console.warn(`Force reclaim: Task ${taskId} is currently claimed by another worker, proceeding anyway`)
        console.warn('Note: This may cause conflicts if the other worker is still active')

        // We'll continue without a formal claim - this is for testing/debugging only
        // In a production system, you might want to add a forceClaimTask GraphQL mutation
      }
      else {
        console.info(`Force reclaim: Successfully claimed task ${taskId} normally`)
      }
    }
    else {
      // Normal claiming behavior
      const claimedState = await client.claimTask({
        taskId: taskId as TraceId,
        workerId,
        ttl: timeoutInterval || 600, // 10 minutes default
      })

      if (claimedState === null) {
        throw new Error('Task could not be claimed - it may be already claimed by another worker or completed')
      }

      console.info(`Successfully claimed task ${taskId}`)
    }

    let outputAsset: DictLazyAsset | null = null
    let success = true

    try {
      const updateCallback: ProgressUpdateType = async (asset: DictLazyAsset) => {
        if (timeoutInterval !== undefined) {
          asset = { ...asset }
          asset.worker_report_timeout = getFutureTimestamp(timeoutInterval)
        }

        // TODO (Phase 2+): Implement PROGRESS version type for task progress reporting
        // Currently disabled in Phase 1 to avoid generating too many short-lived records
        // without CAS garbage collection. Will be re-enabled when we have proper GC.
        console.debug(`Progress update for mandatory task ${taskId} (not persisted in Phase 1)`)
      }

      outputAsset = await execute(inputAsset, {
        taskId,
        update: updateCallback,
        getCreator,
        getCreatorId,
      })
    }
    catch (err) {
      console.error(`Mandatory task execution failed:`, err)
      success = false
      if (err instanceof Error && 'output' in err && typeof err.output === 'object') {
        outputAsset = err.output as (DictLazyAsset | null)
      }
      else {
        outputAsset = {
          error: err instanceof Error ? err.message : String(err),
          error_type: err instanceof Error ? err.constructor.name : 'UnknownError',
        }
      }
    }

    // Store final result
    const assetHash = await safeStore(outputAsset || {}, 'mandatory task result')
    const versionType = success ? 'OUTPUT' : 'ERROR'
    const version = await client.createVersion({
      taskId,
      versionType,
      assetContentHash: toAssetId(assetHash),
      commitMessage: success ? 'Mandatory task completion' : 'Mandatory task failed',
    })

    // Report completion
    try {
      if (success) {
        await client.reportTaskSuccess({
          taskId,
          workerId,
          resultVersionId: version.id,
        })
        console.info(`Mandatory task ${taskId} completed successfully`)
      }
      else {
        await client.reportTaskFailure({
          taskId,
          workerId,
          errorVersionId: version.id,
        })
        console.info(`Mandatory task ${taskId} failed`)
      }
    }
    catch (reportError) {
      const reportErrMessage = reportError instanceof Error ? reportError.message : String(reportError)
      if (reportErrMessage.includes('lease may have expired') || reportErrMessage.includes('not owned by worker')) {
        console.error(`⚠️  Cannot report mandatory task completion for ${taskId}: Worker lease expired. Task will be rescheduled.`)
        return // Gracefully exit without throwing
      }
      throw reportError // Re-throw non-lease errors
    }
  }
  catch (error) {
    // Check for lease expiration errors and handle gracefully
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('lease may have expired') || errorMessage.includes('not owned by worker')) {
      console.error(`⚠️  Cannot complete mandatory task ${taskId}: Worker lease expired or invalid. Task will be rescheduled by another worker.`)
      return // Gracefully exit without throwing
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
