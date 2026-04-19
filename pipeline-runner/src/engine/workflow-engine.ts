// Copyright (c) 2026 Wuji Labs Inc
/**
 * Workflow Engine - v12 Handle-Based API
 *
 * Implements dedicated workflow orchestration service:
 * - Discovers workflow tasks using v12 findRunnableTasks
 * - Creates concurrent orchestrators for each workflow
 * - Maintains long-lived subscriptions to subtask states
 * - Reacts to events to dispatch dependent subtasks
 */

import type { TraceId, UserActionId } from '@playtiss/core'
import { homedir } from 'os'
import { join } from 'path'

import { SqliteEventConsumer } from '../event-bus/sqlite-consumer.js'
import {
  handlePlayerFailedEvent,
  handlePlayerSubmittedEvent,
  handleStaleUpdateRevisionCreated,
  handleTaskCompletedEvent,
  handleTaskFailedEvent,
} from '../event-bus/task-update-handler.js'
import { PipelineGraphQLClient } from '../graphql/pipeline.js'
import type { workflowTaskExecutionState } from '../graphql/types.js'
import { orchestrateWorkflow } from './workflow-orchestration.js'

export interface WorkflowEngineConfig {
  monitoredPipelines: UserActionId[]
  pollInterval: number
  graphqlUrl: string
  mergeDbPath?: string // Deprecated: merge accumulator now in main DB via GraphQL
}

export class WorkflowEngine {
  private running = false
  private activeWorkflows = new Set<TraceId>() // Track active workflow task IDs
  private discoveryLastCursor = new Map<UserActionId, string>()

  // Clients
  private graphqlClient: PipelineGraphQLClient

  // Discovery tracking
  private discoveryLoopPromise: Promise<void> | null = null

  // Lease management
  private workerId: string
  private leaseExtensionLoopPromise: Promise<void> | null = null
  private activeLeases = new Map<TraceId, { claimedAt: number, ttl: number }>()

  // Event Bus
  private eventBusLoopPromise: Promise<void> | null = null
  private eventBusRunning = false

  constructor(private config: WorkflowEngineConfig) {
    this.graphqlClient = new PipelineGraphQLClient(config.graphqlUrl)

    // Deprecated: mergeDbPath no longer needed - merge accumulator now in main DB
    if (config.mergeDbPath) {
      console.warn('⚠️  mergeDbPath config is deprecated - merge accumulator now managed via GraphQL')
    }

    // Generate unique worker ID for this engine instance
    this.workerId = `workflow-engine-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    console.log(`🏷️  Generated worker ID: ${this.workerId}`)
  }

  // ================================================================
  // ENGINE LIFECYCLE
  // ================================================================

  async start(): Promise<void> {
    console.log('🔥 Starting Workflow Engine...')

    this.running = true

    // Start main discovery loop
    this.discoveryLoopPromise = this.runDiscoveryLoop()

    // Start lease extension loop
    this.leaseExtensionLoopPromise = this.runLeaseExtensionLoop()

    // [EVENT BUS] Start event bus consumer loop (NEW)
    this.eventBusLoopPromise = this.runEventBusLoop()

    console.log('✅ Workflow Engine started successfully (with event bus)')
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping Workflow Engine...')

    this.running = false
    this.eventBusRunning = false // Signal event bus to stop

    // Wait for discovery loop to finish
    if (this.discoveryLoopPromise) {
      await this.discoveryLoopPromise
    }

    // Wait for lease extension loop to finish
    if (this.leaseExtensionLoopPromise) {
      await this.leaseExtensionLoopPromise
    }

    // [EVENT BUS] Wait for event bus loop to finish (NEW)
    if (this.eventBusLoopPromise) {
      await this.eventBusLoopPromise
    }

    // Clear active workflows
    console.log(`🚫 Stopping ${this.activeWorkflows.size} active workflows`)
    this.activeWorkflows.clear()

    // Close clients
    await this.graphqlClient.close()

    console.log('✅ Workflow Engine stopped')
  }

  // ================================================================
  // WORKFLOW DISCOVERY LOOP (replaces legacy getTasksByAction)
  // ================================================================

  private async runDiscoveryLoop(): Promise<void> {
    console.log('🔍 Starting workflow discovery loop...')

    while (this.running) {
      try {
        await this.discoverWorkflows()
        await this.monitorOrchestrators()
      }
      catch (error) {
        console.error('❌ Error in discovery loop:', error)
      }

      // Wait before next poll
      if (this.running) {
        await this.sleep(this.config.pollInterval)
      }
    }

    console.log('🔍 Discovery loop ended')
  }

  /**
   * Discover new workflow tasks using v12 findRunnableTasks
   * Replaces: legacy getTasksByAction with backward pagination
   */
  private async discoverWorkflows(): Promise<void> {
    for (const pipelineId of this.config.monitoredPipelines) {
      try {
        // Get cursor for this pipeline
        const after = this.discoveryLastCursor.get(pipelineId)

        // Find runnable tasks for this pipeline action (limit to 5 per iteration for fair discovery)
        const connection = await this.graphqlClient.findRunnableTasks({
          actionId: pipelineId,
          first: 5, // CRITICAL FIX: Process only 5 tasks per iteration to prevent blocking
          after,
        })

        // Process discovered workflow tasks (limited to 5 per iteration)
        for (const edge of connection.edges) {
          const taskExecution = edge.node
          await this.handleDiscoveredWorkflow(taskExecution.taskId)
        }

        // Update cursor for pagination
        if (connection.pageInfo.endCursor) {
          this.discoveryLastCursor.set(
            pipelineId,
            connection.pageInfo.endCursor,
          )
        }

        if (connection.edges.length > 0) {
          console.log(
            `🔍 Discovered ${connection.edges.length} new workflow tasks for pipeline ${pipelineId}`,
          )
        }
      }
      catch (error) {
        console.error(
          `❌ Error discovering workflows for pipeline ${pipelineId}:`,
          error,
        )
      }
    }
  }

  /**
   * Handle a newly discovered workflow task
   * Replaces: createTaskSubscription() for pipeline tasks
   */
  private async handleDiscoveredWorkflow(
    workflowTaskId: TraceId,
  ): Promise<void> {
    // Check if we're already orchestrating this workflow
    if (this.activeWorkflows.has(workflowTaskId)) {
      return // Already being orchestrated
    }

    try {
      // Get workflow task details first
      const workflowTask = await this.graphqlClient.getTask(workflowTaskId)
      if (!workflowTask) {
        console.warn(`⚠️  Could not retrieve workflow task ${workflowTaskId}`)
        return
      }

      // Check current version status to determine runtime state
      let runtimeStatus = 'IDLE'
      if (workflowTask.currentVersion) {
        switch (workflowTask.currentVersion.type) {
          case 'OUTPUT':
            console.log(
              `✅ Workflow task ${workflowTaskId} already completed with OUTPUT version`,
            )
            return // Don't orchestrate completed tasks
          case 'ERROR':
            console.log(
              `💥 Workflow task ${workflowTaskId} already failed with ERROR version`,
            )
            return // Don't orchestrate failed tasks
          case 'REVISION':
            runtimeStatus = 'RUNNING'
            break
          default:
            runtimeStatus = 'IDLE'
        }
      }

      // If task is RUNNING, check if we should retry based on lease expiration
      if (runtimeStatus === 'RUNNING') {
        const shouldRetry
          = await this.checkLeaseExpirationAndScheduleRetry(workflowTaskId)
        if (!shouldRetry) {
          return // Task is still claimed by another worker
        }
      }

      // Attempt to claim the workflow task
      const ttl = 300 // 5 minutes TTL
      const claimResult = await this.graphqlClient.claimWorkflowTask(
        workflowTaskId,
        this.workerId,
        ttl,
      )

      if (!claimResult.claimed) {
        console.log(
          `⏭️  Could not claim workflow task ${workflowTaskId} - another worker has it`,
        )
        // Schedule retry when current lease expires
        await this.scheduleRetryForTask(workflowTaskId)
        return
      }

      const workflowRevisionId = claimResult.workflowRevisionId
      if (!workflowRevisionId) {
        console.error(
          `❌ Claimed workflow task ${workflowTaskId} but no workflowRevisionId returned`,
        )
        return
      }

      console.log(
        `🎯 Successfully claimed and bootstrapping workflow task ${workflowTaskId}`,
      )

      // Track lease for extension
      this.activeLeases.set(workflowTaskId, {
        claimedAt: Date.now(),
        ttl: ttl,
      })

      // Bootstrap workflow execution (one-shot)
      const shouldMonitor = await orchestrateWorkflow({
        workflowTaskId,
        workflowTask,
        workflowRevisionId,
        workerId: this.workerId,
        graphqlClient: this.graphqlClient,
      })

      // Track if workflow should continue being monitored
      if (shouldMonitor) {
        this.activeWorkflows.add(workflowTaskId)
      }
      else {
        // Workflow already completed, clean up lease
        this.activeLeases.delete(workflowTaskId)
      }
    }
    catch (error) {
      console.error(
        `❌ Error handling discovered workflow ${workflowTaskId}:`,
        error,
      )
      // Note: We don't fail the task here since it's not ours to fail
    }
  }

  /**
   * Monitor active workflows and remove completed ones
   */
  private async monitorOrchestrators(): Promise<void> {
    const completedWorkflows: TraceId[] = []

    for (const workflowTaskId of this.activeWorkflows) {
      try {
        const task = await this.graphqlClient.getTask(workflowTaskId)

        // Check if completed
        if (
          task?.currentVersion?.type === 'OUTPUT'
          || task?.currentVersion?.type === 'ERROR'
        ) {
          completedWorkflows.push(workflowTaskId)
        }
      }
      catch (error) {
        console.error(
          `❌ Error checking workflow ${workflowTaskId}:`,
          error,
        )
        // Remove failed workflow from tracking
        completedWorkflows.push(workflowTaskId)
      }
    }

    // Clean up completed workflows
    for (const workflowTaskId of completedWorkflows) {
      this.activeWorkflows.delete(workflowTaskId)
      this.activeLeases.delete(workflowTaskId)
      console.log(`🏁 Workflow ${workflowTaskId} completed`)
    }
  }

  // ================================================================
  // DEBUGGING & MONITORING
  // ================================================================

  /**
   * Get engine status for debugging
   */
  getStatus(): {
    running: boolean
    monitoredPipelines: UserActionId[]
    activeWorkflows: number
    discoveryLastCursors: Record<UserActionId, string>
  } {
    return {
      running: this.running,
      monitoredPipelines: this.config.monitoredPipelines,
      activeWorkflows: this.activeWorkflows.size,
      discoveryLastCursors: Object.fromEntries(
        this.discoveryLastCursor.entries(),
      ),
    }
  }

  /**
   * Get list of active workflow task IDs
   */
  getActiveWorkflows(): TraceId[] {
    return Array.from(this.activeWorkflows)
  }

  // ================================================================
  // LEASE EXTENSION LOOP
  // ================================================================

  /**
   * Run lease extension loop to extend leases for active workflow tasks
   */
  private async runLeaseExtensionLoop(): Promise<void> {
    console.log(`🔄 Starting lease extension loop...`)

    while (this.running) {
      try {
        await this.extendActiveLeases()
      }
      catch (error) {
        console.error('❌ Error in lease extension loop:', error)
      }

      // Check every 60 seconds (extend at 75% of TTL)
      if (this.running) {
        await this.sleep(60000)
      }
    }

    console.log('🔄 Lease extension loop ended')
  }

  /**
   * Extend leases for active workflow tasks before they expire
   */
  private async extendActiveLeases(): Promise<void> {
    const now = Date.now()
    const extensionPromises: Promise<void>[] = []

    for (const [taskId, lease] of this.activeLeases.entries()) {
      const elapsedMs = now - lease.claimedAt
      const ttlMs = lease.ttl * 1000
      const extensionThreshold = ttlMs * 0.75 // Extend at 75% of TTL

      if (elapsedMs >= extensionThreshold) {
        extensionPromises.push(this.extendLease(taskId, lease))
      }
    }

    if (extensionPromises.length > 0) {
      console.log(`🔄 Extending ${extensionPromises.length} leases...`)
      await Promise.allSettled(extensionPromises)
    }
  }

  /**
   * Extend lease for a specific task
   */
  private async extendLease(
    taskId: TraceId,
    _currentLease: { claimedAt: number, ttl: number },
  ): Promise<void> {
    try {
      const newTtl = 300 // 5 minutes TTL
      const claimSuccess = await this.graphqlClient.claimTask(
        taskId,
        this.workerId,
        newTtl,
      )

      if (claimSuccess) {
        // Update lease tracking
        this.activeLeases.set(taskId, {
          claimedAt: Date.now(),
          ttl: newTtl,
        })
        console.log(`⏰ Extended lease for workflow task ${taskId}`)
      }
      else {
        console.warn(
          `⚠️  Failed to extend lease for workflow task ${taskId} - may have been claimed by another worker`,
        )
        // Remove from active leases since we lost it
        this.activeLeases.delete(taskId)
      }
    }
    catch (error) {
      console.error(`❌ Error extending lease for task ${taskId}:`, error)
      // Keep the lease tracking - will retry next cycle
    }
  }

  // ================================================================
  // SMART CLAIMING LOGIC
  // ================================================================

  /**
   * Check if a RUNNING task's lease has expired and schedule retry if needed
   */
  private async checkLeaseExpirationAndScheduleRetry(
    taskId: TraceId,
  ): Promise<boolean> {
    try {
      // Query all runnable tasks to find the specific one
      // Note: We need to paginate through to find our specific task
      let after: string | undefined
      let found = false
      let execution: workflowTaskExecutionState | null = null

      do {
        const connection = await this.graphqlClient.findRunnableTasks({
          first: 50,
          after,
        })

        // Find the specific task in execution states
        const taskExecution = connection.edges.find(
          edge => edge.node.taskId === taskId,
        )
        if (taskExecution) {
          execution = taskExecution.node
          found = true
          break
        }

        after = connection.pageInfo.endCursor || undefined
      } while (after && !found)

      if (!execution) {
        // Task not in execution states - safe to claim
        console.log(
          `📝 Task ${taskId} not found in execution states, safe to claim`,
        )
        return true
      }

      // Check if lease has expired
      if (execution.claim_timestamp && execution.claim_ttl_seconds) {
        const claimTime = new Date(execution.claim_timestamp).getTime()
        const ttlMs = execution.claim_ttl_seconds * 1000
        const expirationTime = claimTime + ttlMs
        const now = Date.now()

        if (now >= expirationTime) {
          console.log(
            `⏰ Lease expired for task ${taskId}, can retry claiming`,
          )
          return true
        }
        else {
          const remainingMs = expirationTime - now
          console.log(
            `⏳ Task ${taskId} lease expires in ${Math.round(remainingMs / 1000)}s, scheduling retry`,
          )
          await this.scheduleRetryForTask(taskId, remainingMs)
          return false
        }
      }

      // No claim info or already expired - safe to claim
      return true
    }
    catch (error) {
      console.error(`Error checking lease expiration for ${taskId}:`, error)
      // On error, assume we can try to claim
      return true
    }
  }

  /**
   * Schedule a retry attempt for a task after its lease expires
   */
  private async scheduleRetryForTask(
    taskId: TraceId,
    delayMs?: number,
  ): Promise<void> {
    // Default to 5 minutes if no specific delay provided
    const retryDelay = delayMs || 5 * 60 * 1000

    console.log(
      `📅 Scheduling retry for task ${taskId} in ${Math.round(retryDelay / 1000)}s`,
    )

    setTimeout(async () => {
      if (this.running) {
        console.log(`🔄 Retrying task ${taskId} after lease expiration`)
        await this.handleDiscoveredWorkflow(taskId)
      }
    }, retryDelay)
  }

  // ================================================================
  // OUTPUT CHANGE HANDLING
  // ================================================================
  // Note: Output changes are now handled naturally by the event bus.
  // When a task's output changes, a new task_completed event is produced,
  // which the event bus consumes and processes via handleTaskCompletion.
  // The scheduler automatically handles dependent task updates without
  // needing explicit workflow restart logic.

  // ================================================================
  // EVENT BUS LOOP (replaces polling)
  // ================================================================

  /**
   * Event Bus Consumer Loop
   *
   * Subscribes to task completion/failure events and processes them
   * by calling handleTaskCompletion/handleTaskFailure (which call propagateToNode)
   *
   * This replaces the polling logic in WorkflowOrchestrator.handleSubtaskUpdate()
   */
  private async runEventBusLoop(): Promise<void> {
    console.log('📡 Starting Event Bus consumer loop...')

    // Get database path (same as GraphQL server)
    const dbPath
      = process.env.PLAYTISS_DB_PATH
        || join(homedir(), '.playtiss', 'playtiss.db')

    const consumer = new SqliteEventConsumer(dbPath)
    const subscription = await consumer.subscribe(
      'WorkflowRevisionNodeStates_Updater', // Projection ID for crash recovery
      ['task_completed', 'task_failed', 'task_player_submitted', 'task_player_failed', 'stale_update_revision_created'], // Topics to subscribe to
    )

    this.eventBusRunning = true
    console.log('📡 Event bus consumer started successfully')

    while (this.eventBusRunning) {
      try {
        // Poll for events (batch size: 10)
        const events = await subscription.poll(10)

        if (events.length === 0) {
          // No new events, wait 3 seconds
          await this.sleep(3000)
          continue
        }

        console.log(`📬 Received ${events.length} events from event bus`)

        // Process each event
        for (const event of events) {
          try {
            console.log(`🔄 Processing event: ${event.topic} (${event.id})`)

            switch (event.topic) {
              case 'task_completed':
                // This will call handleTaskCompletion → propagateToNode
                await handleTaskCompletedEvent(
                  event,
                  this.graphqlClient,
                  this.workerId,
                )
                break

              case 'task_player_submitted': // v14: Player input with revision fork
                await handlePlayerSubmittedEvent(
                  event,
                  this.graphqlClient,
                )
                break

              case 'task_failed':
                // This will call handleTaskFailure
                await handleTaskFailedEvent(
                  event,
                  this.graphqlClient,
                  this.workerId,
                )
                break

              case 'task_player_failed': // v14: Player failure with revision fork
                await handlePlayerFailedEvent(
                  event,
                  this.graphqlClient,
                )
                break

              case 'stale_update_revision_created':
                // Handle stale detection revision creation (v13)
                await handleStaleUpdateRevisionCreated(
                  event,
                  this.graphqlClient,
                  this.workerId,
                )
                break

              default:
                console.warn(`⚠️  Unknown event topic: ${event.topic}`)
            }

            // Commit offset after successful processing
            // This enables crash recovery - restart will resume from this point
            await subscription.commit(event)
            console.log(`✅ Committed event ${event.id}`)
          }
          catch (error) {
            console.error(`❌ Error processing event ${event.id}:`, error)
            // Don't commit - event will be retried on next poll
            break // Stop processing this batch to avoid cascading failures
          }
        }
      }
      catch (error) {
        console.error('❌ Event bus loop error:', error)
        // Wait before retrying
        await this.sleep(5000)
      }
    }

    // Clean up
    try {
      await subscription.close()
      console.log('📡 Event bus consumer stopped')
    }
    catch (error) {
      console.error('❌ Error closing event bus subscription:', error)
    }
  }

  // ================================================================
  // UTILITIES
  // ================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
