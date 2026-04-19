// Copyright (c) 2026 Wuji Labs Inc
/**
 * Task Iterator for TypeScript Worker
 *
 * Implements forward pagination for discovering and monitoring runnable tasks.
 * Uses server-side SQL filtering with cursor-based Relay pagination.
 */
import type { ActionId, TraceId } from '@playtiss/core'

import { GraphQLClient } from './graphql-client.js'

export interface TaskInfo {
  taskId: TraceId
  actionId: string
  name?: string | null
  description?: string | null
  inputsContentHash?: string | null
  createdAt: number
  runtimeStatus: string
}

export class TaskIterator {
  private client: GraphQLClient
  private actionId: ActionId
  private pollInterval: number
  private batchSize: number
  private lastCursor: string | null = null
  private stopRequested = false
  private pendingTasks = new Set<TraceId>()
  private lastPendingCheck = 0
  private yieldedTaskIds = new Set<TraceId>() // Track tasks already yielded in current poll cycle

  constructor(
    client: GraphQLClient,
    actionId: ActionId,
    options: {
      pollInterval?: number
      batchSize?: number
    } = {},
  ) {
    this.client = client
    this.actionId = actionId
    this.pollInterval = options.pollInterval || 5000 // 5 seconds
    this.batchSize = options.batchSize || 10
  }

  stop(): void {
    this.stopRequested = true
  }

  markTaskCompleted(taskId: TraceId): void {
    this.pendingTasks.delete(taskId)
    this.yieldedTaskIds.delete(taskId)
    console.debug(`Removed task ${taskId} from pending retry set`)
  }

  async* [Symbol.asyncIterator](): AsyncIterator<TaskInfo> {
    while (!this.stopRequested) {
      try {
        const currentTime = Date.now()
        let yieldedAny = false

        // 1. Check for new tasks using cursor-based pagination
        const connection = await this.client.findRunnableTasks({
          first: this.batchSize,
          actionId: this.actionId,
          after: this.lastCursor || undefined,
        })

        if (connection.edges.length > 0) {
          // Count only tasks we haven't yielded yet
          const newTaskIds = connection.edges
            .map(e => e.node.taskId)
            .filter(id => !this.yieldedTaskIds.has(id))

          if (newTaskIds.length > 0) {
            console.info(`Found ${newTaskIds.length} new runnable tasks`)
          }

          for (const edge of connection.edges) {
            const taskState = edge.node
            const taskId = taskState.taskId

            // Skip tasks we've already yielded in this poll cycle
            if (this.yieldedTaskIds.has(taskId)) {
              continue
            }

            // Fetch full task details
            const task = await this.client.getTask(taskId as TraceId)
            if (task) {
              const taskInfo: TaskInfo = {
                taskId,
                actionId: task.actionId,
                name: task.name,
                description: task.description,
                inputsContentHash: task.inputsContentHash,
                createdAt: task.createdAt,
                runtimeStatus: taskState.runtimeStatus,
              }

              // Add PENDING tasks to retry set (only log if newly added)
              if (taskState.runtimeStatus === 'PENDING') {
                if (!this.pendingTasks.has(taskId)) {
                  this.pendingTasks.add(taskId)
                  console.debug(`Added task ${taskId} to pending retry set`)
                }
              }

              // Mark as yielded to avoid re-yielding in tight loop
              this.yieldedTaskIds.add(taskId)
              yield taskInfo
              yieldedAny = true
            }
          }

          // Update cursor for next fetch
          if (connection.pageInfo.hasNextPage) {
            this.lastCursor = connection.pageInfo.endCursor || null
          }
        }

        // 2. Periodically re-yield tasks from our pending set for claim attempts
        if (
          (currentTime - this.lastPendingCheck) >= this.pollInterval
          && this.pendingTasks.size > 0
        ) {
          console.debug(`Re-yielding ${this.pendingTasks.size} pending tasks for claim attempts`)
          this.lastPendingCheck = currentTime

          // Clear the yielded set so pending tasks can be re-yielded
          this.yieldedTaskIds.clear()

          // Re-yield pending tasks - the claim attempt will determine their status
          for (const taskId of Array.from(this.pendingTasks)) {
            try {
              // Get task details for yielding
              const task = await this.client.getTask(taskId as TraceId)
              if (task) {
                this.yieldedTaskIds.add(taskId)
                yield {
                  taskId,
                  actionId: task.actionId,
                  name: task.name,
                  description: task.description,
                  inputsContentHash: task.inputsContentHash,
                  createdAt: task.createdAt,
                  runtimeStatus: 'PENDING', // Assume pending, claim will verify
                }
                yieldedAny = true
              }
            }
            catch (error) {
              console.error(`Error re-yielding pending task ${taskId}:`, error)
              // Remove problematic task from pending set
              this.pendingTasks.delete(taskId)
            }
          }
        }

        // 3. If no new tasks were yielded, wait before next poll
        if (!yieldedAny) {
          await this.sleep(this.pollInterval)
          // Clear yielded set after sleep so tasks can be checked again
          this.yieldedTaskIds.clear()
        }
      }
      catch (error) {
        console.error('Error in task iterator:', error)
        await this.sleep(this.pollInterval)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async fetchTaskDetails(taskId: TraceId): Promise<TaskInfo | null> {
    try {
      const task = await this.client.getTask(taskId)
      if (!task) return null

      return {
        taskId,
        actionId: task.actionId,
        name: task.name,
        description: task.description,
        inputsContentHash: task.inputsContentHash,
        createdAt: task.createdAt,
        runtimeStatus: 'UNKNOWN', // Would need to be fetched separately
      }
    }
    catch (error) {
      console.error(`Error fetching task details for ${taskId}:`, error)
      return null
    }
  }
}

/**
 * Rate-limited task iterator to prevent overwhelming the server
 */
export class RateLimitedTaskIterator extends TaskIterator {
  private maxRequestsPerMinute: number
  private requestTimes: number[] = []

  constructor(
    client: GraphQLClient,
    actionId: ActionId,
    maxRequestsPerMinute: number = 60,
    options: {
      pollInterval?: number
      batchSize?: number
    } = {},
  ) {
    super(client, actionId, options)
    this.maxRequestsPerMinute = maxRequestsPerMinute
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now()
    const minuteAgo = now - 60000

    // Remove old request times
    this.requestTimes = this.requestTimes.filter(time => time > minuteAgo)

    // If we've hit the limit, wait
    if (this.requestTimes.length >= this.maxRequestsPerMinute) {
      const waitTime = 60000 - (now - this.requestTimes[0])
      if (waitTime > 0) {
        console.debug(`Rate limit reached, waiting ${waitTime}ms`)
        await this.sleepRate(waitTime)
      }
    }

    // Record this request
    this.requestTimes.push(now)
  }

  async* [Symbol.asyncIterator](): AsyncIterableIterator<TaskInfo> {
    const baseIterator = super[Symbol.asyncIterator]()
    let result = await baseIterator.next()

    while (!result.done) {
      await this.waitForRateLimit()
      yield result.value
      result = await baseIterator.next()
    }
  }

  private sleepRate(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
