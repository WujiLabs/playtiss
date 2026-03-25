// Copyright (c) 2026 Wuji Labs Inc
/**
 * TypeScript Worker - Main Entry Point
 *
 * This is the main entry point for the TypeScript Compute Worker,
 * equivalent to the Python playtiss-action-runner package.
 */

// Auto-load configuration before importing other modules
import './config.js'

import type { ActionId, DictAsset } from 'playtiss'
import { isTraceId } from 'playtiss/types/trace_id'
import { getWorkerConfig, validateConfig } from './config.js'
import { createClient } from './graphql-client.js'
import { executeSingleTask, runWorkerLoop, type CallbackType } from './runner.js'

// Re-export types and classes for external use
export { findAndLoadEnv, getWorkerConfig, validateConfig, type WorkerConfig } from './config.js'
export { createClient, GraphQLClient } from './graphql-client.js'
export { executeTask, executeSingleTask, runWorkerLoop, type CallbackType, type RunnerContext } from './runner.js'
export { RateLimitedTaskIterator, TaskIterator, type TaskInfo } from './task-iterator.js'

/**
 * Worker class that encapsulates the complete worker functionality
 */
export class TypeScriptWorker {
  private config: ReturnType<typeof getWorkerConfig>
  private stopRequested = false

  constructor(actionId?: ActionId, customConfig?: Partial<ReturnType<typeof getWorkerConfig>>) {
    this.config = { ...getWorkerConfig(), ...customConfig }

    if (actionId) {
      this.config.actionId = actionId
    }

    // Generate unique worker ID if not provided
    if (!this.config.workerId) {
      this.config.workerId = `ts-worker-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    }

    // Validate configuration
    const validation = validateConfig(this.config)
    if (!validation.valid) {
      throw new Error(`Invalid worker configuration: ${validation.errors.join(', ')}`)
    }
  }

  /**
   * Start the worker with a custom task execution function
   */
  async start(execute: CallbackType): Promise<void> {
    if (!this.config.actionId) {
      throw new Error('ACTION_ID must be specified')
    }

    console.log(`Starting TypeScript Worker for action: ${this.config.actionId}`)
    console.log(`Worker ID: ${this.config.workerId}`)
    console.log(`GraphQL URL: ${this.config.graphqlUrl}`)
    console.log(`Concurrency: ${this.config.concurrency}`)
    console.log(`Poll Interval: ${this.config.pollInterval}ms`)

    try {
      await runWorkerLoop(this.config.actionId as ActionId, execute, {
        workerId: this.config.workerId,
        authToken: this.config.authToken,
        concurrency: this.config.concurrency,
        pollInterval: this.config.pollInterval,
        batchSize: this.config.batchSize,
        timeoutInterval: this.config.timeoutInterval,
        graphqlUrl: this.config.graphqlUrl,
        testRun: false,
      })
    }
    catch (error) {
      if (this.stopRequested) {
        console.log('Worker stopped by request')
      }
      else {
        console.error('Worker error:', error)
        throw error
      }
    }
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.stopRequested = true
    console.log('Worker stop requested')
  }

  /**
   * Execute a single task (for testing or manual execution)
   */
  async executeTask(
    taskId: string,
    execute: CallbackType,
    options: { forceReclaim?: boolean } = {},
  ): Promise<void> {
    if (!isTraceId(taskId)) {
      throw new Error('Invalid task ID')
    }
    console.log(`Executing single task: ${taskId}`)

    await executeSingleTask(taskId, execute, {
      workerId: this.config.workerId,
      authToken: this.config.authToken,
      timeoutInterval: this.config.timeoutInterval,
      forceReclaim: options.forceReclaim,
      graphqlUrl: this.config.graphqlUrl,
    })
  }

  /**
   * Test the worker configuration and connection
   */
  async test(): Promise<{ success: boolean, errors: string[] }> {
    const errors: string[] = []

    try {
      // Test GraphQL connection
      const client = createClient(this.config.graphqlUrl, this.config.workerId, this.config.authToken)

      // Try to fetch runnable tasks (this tests the connection and auth)
      if (this.config.actionId) {
        await client.findRunnableTasks({
          actionId: this.config.actionId as ActionId,
          first: 1,
        })
      }

      await client.close()
      console.log('✅ GraphQL connection test passed')
    }
    catch (error) {
      errors.push(`GraphQL connection failed: ${error}`)
    }

    return {
      success: errors.length === 0,
      errors,
    }
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.config }
  }
}

/**
 * Create a simple worker with minimal configuration
 */
export function createWorker(actionId: ActionId, options: {
  workerId?: string
  graphqlUrl?: string
  authToken?: string
  concurrency?: number
  pollInterval?: number
  batchSize?: number
  timeoutInterval?: number
} = {}): TypeScriptWorker {
  return new TypeScriptWorker(actionId, options)
}

/**
 * Quick start function for running a worker with minimal setup
 */
export async function runWorker(
  actionId: ActionId,
  execute: CallbackType,
  options: {
    workerId?: string
    graphqlUrl?: string
    authToken?: string
    concurrency?: number
    pollInterval?: number
    batchSize?: number
    timeoutInterval?: number
  } = {},
): Promise<void> {
  const worker = createWorker(actionId, options)

  // Handle graceful shutdown
  const shutdown = () => {
    console.log('\nShutdown signal received, stopping worker...')
    worker.stop()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    await worker.start(execute)
  }
  finally {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }
}

/**
 * Example task execution function for demonstration
 */
export async function exampleTaskExecutor(
  input: DictAsset,
  context: import('./runner.js').RunnerContext,
): Promise<DictAsset> {
  console.log(`Example task ${context.taskId} executing with input:`, input)

  // Simulate some work
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Report progress
  await context.update({
    status: 'processing',
    progress: 50,
    timestamp: Date.now(),
  })

  // Simulate more work
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Return result
  return {
    result: 'Task completed successfully',
    input_summary: Object.keys(input).length,
    processed_at: Date.now(),
    worker_id: 'typescript-worker-example',
  }
}

// CLI support when run directly
// Skip this check when built as CJS (import.meta is empty/undefined in CJS)
if (import.meta && import.meta.url === `file://${process.argv[1]}`) {
  const actionId = process.env.ACTION_ID

  if (!actionId) {
    console.error('Please set ACTION_ID environment variable')
    process.exit(1)
  }

  console.log('Starting TypeScript Worker with example executor...')

  runWorker(actionId as ActionId, exampleTaskExecutor)
    .then(() => {
      console.log('Worker finished')
    })
    .catch((error) => {
      console.error('Worker failed:', error)
      process.exit(1)
    })
}
