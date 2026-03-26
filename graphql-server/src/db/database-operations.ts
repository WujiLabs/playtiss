// Copyright (c) 2026 Wuji Labs Inc
/**
 * Database Operations Abstraction Layer
 *
 * Separates "external mutations" (GraphQL resolvers) from "internal operations" (low-level DB calls).
 * This pattern makes future database migrations easier and provides clean transaction boundaries.
 *
 * Architecture:
 * - External Mutations: High-level operations called by GraphQL resolvers (serialized for SQLite)
 * - Internal Operations: Low-level DB operations that run within transactions
 * - Clean separation allows easy migration to different database systems
 */

import type { Database } from 'better-sqlite3'
import type { AssetId } from 'playtiss'
import { default_scope_id } from 'playtiss'
import type { TraceId } from 'playtiss/types/trace_id'

import { getDB } from '../db.js'
import { SqliteEventProducer } from '../event-bus/sqlite-producer.js'
import { withTransaction } from './mutation-serializer.js'

// ================================================================
// INTERNAL OPERATIONS (run within transactions)
// ================================================================

/**
 * Low-level database operations that run within transactions
 * These are the "internal operations" that don't manage their own transactions
 */
export class InternalDatabaseOperations {
  /**
   * Create a task record
   */
  static createTask(
    db: Database,
    data: {
      taskId: TraceId
      scopeId: string
      actionId: string
      inputsContentHash?: string
      name?: string
      description?: string
      timestamp: number
    },
  ): void {
    db.prepare(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.taskId,
      data.scopeId,
      data.actionId,
      data.inputsContentHash,
      data.name,
      data.description,
      data.timestamp,
    )
  }

  /**
   * Create a version record
   */
  static createVersion(
    db: Database,
    data: {
      versionId: TraceId
      taskId: TraceId
      versionType: string
      assetContentHash?: string
      parentVersionId?: TraceId
      executedDefVersionId?: TraceId
      timestamp: number
      userTag?: string
      commitMessage?: string
    },
  ): void {
    db.prepare(
      `INSERT INTO Versions (version_id, task_id, version_type_tag, asset_content_hash,
                               parent_version_id, executed_def_version_id, timestamp_created,
                               user_given_tag, commit_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.versionId,
      data.taskId,
      data.versionType,
      data.assetContentHash,
      data.parentVersionId,
      data.executedDefVersionId,
      data.timestamp,
      data.userTag,
      data.commitMessage,
    )
  }

  /**
   * Update task's current version
   */
  static updateTaskCurrentVersion(
    db: Database,
    taskId: TraceId,
    versionId: TraceId,
  ): void {
    db.prepare(
      `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
    ).run(versionId, taskId)
  }

  /**
   * Update task's active revision ID (points to latest REVISION version)
   */
  static updateTaskActiveRevision(
    db: Database,
    taskId: TraceId,
    revisionId: TraceId,
  ): void {
    db.prepare(
      `UPDATE Tasks SET active_revision_id = ? WHERE task_id = ?`,
    ).run(revisionId, taskId)
  }

  /**
   * Get active revision ID for a task (O(1) lookup)
   * Returns the latest REVISION version ID for the given task
   */
  static getActiveRevisionId(
    db: Database,
    taskId: TraceId,
  ): TraceId | null {
    const row = db.prepare(
      `SELECT active_revision_id FROM Tasks WHERE task_id = ?`,
    ).get(taskId) as any
    return row?.active_revision_id || null
  }

  /**
   * Fork a workflow revision - Copy-on-Write revision management (v14)
   *
   * This implements the core "Mutable Head, Immutable Tail" pattern:
   * - Copies all WorkflowRevisionNodeStates from parent to new revision
   * - Creates new Versions record with parent linkage
   * - Updates Tasks.current_version_id to point to new revision
   *
   * Transaction model:
   * - State copying (INSERT...SELECT) runs OUTSIDE transaction (can retry)
   * - Versions + Tasks update runs IN transaction (atomic pointer switch)
   *
   * This minimizes transaction lock time while ensuring consistency.
   *
   * @param db Database instance (state copy uses db but not in transaction)
   * @param data Fork parameters
   */
  /**
   * Part 1: Duplicate workflow revision node states (NON-transactional, retryable)
   * This is the state copying phase that can be done outside transactions
   *
   * v14.1 Update: Also copies PipelineMergeAccumulator to preserve merge node state
   */
  static duplicateWorkflowRevisionNodeStates(
    db: Database,
    data: {
      parentRevisionId: TraceId
      newRevisionId: TraceId
    },
  ): void {
    // Copy WorkflowRevisionNodeStates
    db.prepare(
      `INSERT INTO WorkflowRevisionNodeStates (
          workflow_revision_id, node_id_in_workflow, context_asset_hash,
          required_task_id, last_used_version_id, last_inputs_hash,
          dependency_status, runtime_status, error_message, meta_asset_hash
        )
        SELECT
          ? AS new_revision_id,
          node_id_in_workflow, context_asset_hash,
          required_task_id, last_used_version_id, last_inputs_hash,
          dependency_status, runtime_status, error_message, meta_asset_hash
        FROM WorkflowRevisionNodeStates
        WHERE workflow_revision_id = ?`,
    ).run(data.newRevisionId, data.parentRevisionId)

    // Copy PipelineMergeAccumulator (v14.1 - preserve merge node state on fork)
    try {
      db.prepare(
        `INSERT INTO PipelineMergeAccumulator (
          pipeline_id, workflow_revision_id, context_asset_hash, node_id,
          accumulator_json, created_at, updated_at
        )
        SELECT
          pipeline_id,
          ? AS new_revision_id,
          context_asset_hash, node_id,
          accumulator_json, created_at,
          strftime('%s', 'now') AS updated_at
        FROM PipelineMergeAccumulator
        WHERE workflow_revision_id = ?`,
      ).run(data.newRevisionId, data.parentRevisionId)
    }
    catch (err: any) {
      // Ignore errors if no merge accumulator exists (this is optional data)
      console.warn(
        `Note: Could not copy merge accumulator (might not exist): ${err.message}`,
      )
    }
  }

  /**
   * Update node runtime status (preserves dependency status)
   * Used by player input mutations and rerun operations
   */
  static updateNodeRuntimeStatus(
    db: Database,
    data: {
      workflowRevisionId: TraceId
      nodeId: string
      contextAssetHash: AssetId
      runtimeStatus: 'IDLE' | 'RUNNING' | 'FAILED'
    },
  ): void {
    const result = db.prepare(
      `UPDATE WorkflowRevisionNodeStates
         SET runtime_status = ?
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
    ).run(
      data.runtimeStatus,
      data.workflowRevisionId,
      data.nodeId,
      data.contextAssetHash,
    )
    if (result.changes === 0) {
      throw new Error(
        `Node ${data.nodeId} not found in workflow revision ${data.workflowRevisionId}`,
      )
    }
  }

  /**
   * Part 2: Finalize revision fork (MUST be in transaction)
   * Creates Versions record and updates Tasks.current_version_id pointer
   * Assumes caller has already begun transaction
   */
  static finalizeRevisionFork(
    db: Database,
    data: {
      taskId: TraceId
      parentRevisionId: TraceId
      newRevisionId: TraceId
      timestamp: number
      commitMessage?: string
      triggerReason?: string
    },
  ): void {
    // Create Versions record
    db.prepare(
      `INSERT INTO Versions (
          version_id, task_id, version_type_tag,
          parent_version_id, timestamp_created, commit_message
        ) VALUES (?, ?, 'REVISION', ?, ?, ?)`,
    ).run(
      data.newRevisionId,
      data.taskId,
      data.parentRevisionId,
      data.timestamp,
      data.commitMessage || data.triggerReason || 'Revision fork',
    )

    // Update Tasks.current_version_id AND active_revision_id pointers
    // Both point to the new revision since this is a fork operation
    db.prepare(
      `UPDATE Tasks SET current_version_id = ?, active_revision_id = ? WHERE task_id = ?`,
    ).run(data.newRevisionId, data.newRevisionId, data.taskId)
  }

  /**
   * Create task execution state
   */
  static createTaskExecutionState(
    db: Database,
    data: {
      taskId: TraceId
      actionId: string
      runtimeStatus: string
      claimTimestamp?: number
      claimWorkerId?: string
      claimTtlSeconds?: number
      expirationTime?: number
    },
  ): void {
    db.prepare(
      `INSERT INTO TaskExecutionStates (task_id, action_id, runtime_status, claim_timestamp,
                                         claim_worker_id, claim_ttl_seconds, expiration_time)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.taskId,
      data.actionId,
      data.runtimeStatus,
      data.claimTimestamp,
      data.claimWorkerId,
      data.claimTtlSeconds,
      data.expirationTime,
    )
  }

  /**
   * Update task execution state with worker verification (for completing tasks)
   */
  static updateTaskExecutionStateWithWorkerCheck(
    db: Database,
    taskId: TraceId,
    workerId: string,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): { changedRows: number } {
    const setParts: string[] = []
    const values: any[] = []

    if (updates.runtimeStatus !== undefined) {
      setParts.push('runtime_status = ?')
      values.push(updates.runtimeStatus)
    }
    if (updates.claimTimestamp !== undefined) {
      setParts.push('claim_timestamp = ?')
      values.push(updates.claimTimestamp)
    }
    if (updates.claimWorkerId !== undefined) {
      setParts.push('claim_worker_id = ?')
      values.push(updates.claimWorkerId)
    }
    if (updates.claimTtlSeconds !== undefined) {
      setParts.push('claim_ttl_seconds = ?')
      values.push(updates.claimTtlSeconds)
    }
    if (updates.expirationTime !== undefined) {
      setParts.push('expiration_time = ?')
      values.push(updates.expirationTime)
    }

    if (setParts.length === 0) {
      return { changedRows: 0 }
    }

    // Add WHERE clause to verify worker ownership and lease hasn't expired
    values.push(taskId)
    values.push(workerId)
    values.push(Date.now()) // Current timestamp to check expiration

    const result = db.prepare(
      `UPDATE TaskExecutionStates SET ${setParts.join(', ')}
         WHERE task_id = ? AND claim_worker_id = ? AND expiration_time > ?`,
    ).run(...values)

    return { changedRows: result.changes }
  }

  /**
   * Update task execution state (for claiming/completing tasks)
   */
  static updateTaskExecutionState(
    db: Database,
    taskId: TraceId,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): { changedRows: number } {
    const setParts: string[] = []
    const values: any[] = []

    if (updates.runtimeStatus !== undefined) {
      setParts.push('runtime_status = ?')
      values.push(updates.runtimeStatus)
    }
    if (updates.claimTimestamp !== undefined) {
      setParts.push('claim_timestamp = ?')
      values.push(updates.claimTimestamp)
    }
    if (updates.claimWorkerId !== undefined) {
      setParts.push('claim_worker_id = ?')
      values.push(updates.claimWorkerId)
    }
    if (updates.claimTtlSeconds !== undefined) {
      setParts.push('claim_ttl_seconds = ?')
      values.push(updates.claimTtlSeconds)
    }
    if (updates.expirationTime !== undefined) {
      setParts.push('expiration_time = ?')
      values.push(updates.expirationTime)
    }

    if (setParts.length === 0) {
      return { changedRows: 0 }
    }

    values.push(taskId)

    const result = db.prepare(
      `UPDATE TaskExecutionStates SET ${setParts.join(', ')} WHERE task_id = ?`,
    ).run(...values)

    return { changedRows: result.changes }
  }

  /**
   * Update task execution state with status check (for refresh operations)
   */
  static updateTaskExecutionStateWithStatusCheck(
    db: Database,
    taskId: TraceId,
    fromStatuses: string[],
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): { changedRows: number } {
    const setParts: string[] = []
    const values: any[] = []

    if (updates.runtimeStatus !== undefined) {
      setParts.push('runtime_status = ?')
      values.push(updates.runtimeStatus)
    }
    if (updates.claimTimestamp !== undefined) {
      setParts.push('claim_timestamp = ?')
      values.push(updates.claimTimestamp)
    }
    if (updates.claimWorkerId !== undefined) {
      setParts.push('claim_worker_id = ?')
      values.push(updates.claimWorkerId)
    }
    if (updates.claimTtlSeconds !== undefined) {
      setParts.push('claim_ttl_seconds = ?')
      values.push(updates.claimTtlSeconds)
    }
    if (updates.expirationTime !== undefined) {
      setParts.push('expiration_time = ?')
      values.push(updates.expirationTime)
    }

    if (setParts.length === 0) {
      return { changedRows: 0 }
    }

    // Add WHERE clause to check current status is one of the allowed states
    const statusPlaceholders = fromStatuses.map(() => '?').join(', ')
    values.push(taskId)
    values.push(...fromStatuses)

    const result = db.prepare(
      `UPDATE TaskExecutionStates SET ${setParts.join(', ')}
         WHERE task_id = ? AND runtime_status IN (${statusPlaceholders})`,
    ).run(...values)

    return { changedRows: result.changes }
  }

  /**
   * Update task execution state for claiming (with claim eligibility check)
   */
  static updateTaskExecutionStateForClaim(
    db: Database,
    taskId: TraceId,
    workerId: string,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number
      claimWorkerId?: string
      claimTtlSeconds?: number
      expirationTime?: number
    },
  ): { changedRows: number } {
    const setParts: string[] = []
    const values: any[] = []

    if (updates.runtimeStatus !== undefined) {
      setParts.push('runtime_status = ?')
      values.push(updates.runtimeStatus)
    }
    if (updates.claimTimestamp !== undefined) {
      setParts.push('claim_timestamp = ?')
      values.push(updates.claimTimestamp)
    }
    if (updates.claimWorkerId !== undefined) {
      setParts.push('claim_worker_id = ?')
      values.push(updates.claimWorkerId)
    }
    if (updates.claimTtlSeconds !== undefined) {
      setParts.push('claim_ttl_seconds = ?')
      values.push(updates.claimTtlSeconds)
    }
    if (updates.expirationTime !== undefined) {
      setParts.push('expiration_time = ?')
      values.push(updates.expirationTime)
    }

    if (setParts.length === 0) {
      return { changedRows: 0 }
    }

    const currentTime = updates.claimTimestamp || Date.now()
    values.push(taskId, currentTime, workerId, currentTime)

    const result = db.prepare(
      `UPDATE TaskExecutionStates SET ${setParts.join(', ')}
         WHERE task_id = ?
         AND (runtime_status = 'PENDING' OR
              (runtime_status = 'RUNNING' AND claim_timestamp IS NOT NULL AND (? - claim_timestamp) / 1000.0 > claim_ttl_seconds) OR
              (runtime_status = 'RUNNING' AND claim_worker_id = ? AND claim_timestamp IS NOT NULL AND (? - claim_timestamp) / 1000.0 <= claim_ttl_seconds))`,
    ).run(...values)

    return { changedRows: result.changes }
  }

  /**
   * Create execution handle
   */
  static createExecutionHandle(
    db: Database,
    data: {
      handleId: TraceId
      taskId: TraceId
      createdAt: number
      createdBy: string
      description?: string
    },
  ): void {
    db.prepare(
      `INSERT INTO ExecutionHandles (handle_id, task_id, created_at, created_by, description)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
      data.handleId,
      data.taskId,
      data.createdAt,
      data.createdBy,
      data.description,
    )
  }

  /**
   * Query operations (can be used both internally and externally)
   */

  static getTask(db: Database, taskId: TraceId): any {
    return db.prepare(`SELECT * FROM Tasks WHERE task_id = ?`).get(taskId)
  }

  static getVersion(
    db: Database,
    versionId: TraceId,
  ): any {
    return db.prepare(
      `SELECT * FROM Versions WHERE version_id = ?`,
    ).get(versionId)
  }

  static getTaskExecutionState(
    db: Database,
    taskId: TraceId,
  ): any {
    return db.prepare(
      `SELECT * FROM TaskExecutionStates WHERE task_id = ?`,
    ).get(taskId)
  }

  /**
   * Fetch existing task by uniqueness parameters (scope, action, inputs hash)
   * Used for idempotent task creation and race condition handling
   */
  static fetchTaskByUniqueness(
    db: Database,
    actionId: string,
    uniquenessHash: AssetId,
  ): any | null {
    const row = db.prepare(
      `SELECT t.task_id, t.action_id, t.name, t.description, t.timestamp_created, t.current_version_id,
                v.version_id, v.version_type_tag, v.asset_content_hash, v.timestamp_created as version_timestamp, v.commit_message
         FROM Tasks t
         LEFT JOIN Versions v ON t.current_version_id = v.version_id
         WHERE t.scope_id = ? AND t.action_id = ? AND t.inputs_content_hash = ?`,
    ).get(default_scope_id, actionId, uniquenessHash)
    return row || null
  }
}

// ================================================================
// EXTERNAL MUTATIONS (called by GraphQL resolvers)
// ================================================================

/**
 * High-level database operations called by GraphQL resolvers
 * These are the "external mutations" that manage their own transactions and serialization
 */
export class ExternalDatabaseMutations {
  /**
   * Claim a workflow task and generate revision version
   * This is an external mutation that manages its own transaction
   */
  static claimWorkflowTask(
    taskId: TraceId,
    workerId: string,
    ttl: number,
    revisionVersionId: TraceId,
    timestamp: number,
  ): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  } {
    return withTransaction('claimWorkflowTask', db =>
      executeClaimWorkflowTaskInternal(db, taskId, workerId, ttl, revisionVersionId, timestamp),
    )
  }

  /**
   * Create a computational task and schedule for execution
   */
  static createComputationalTask(
    actionId: string,
    uniquenessHash: AssetId,
    taskId: TraceId,
    timestamp: number,
  ): { id: TraceId, actionId: string, inputsContentHash: string } {
    return withTransaction('createComputationalTask', db =>
      executeCreateComputationalTaskInternal(db, actionId, uniquenessHash, taskId, timestamp),
    )
  }

  /**
   * Request execution and return handle ID
   */
  static requestExecution(
    actionId: string,
    inputAssetId: AssetId,
    handleId: TraceId,
    workflowInstanceTaskId: TraceId,
    timestamp: number,
  ): TraceId {
    return withTransaction('requestExecution', (db) => {
      executeRequestExecutionInternal(db, actionId, inputAssetId, handleId, workflowInstanceTaskId, timestamp)
      return handleId
    })
  }

  /**
   * Claim a regular computational task
   */
  static claimTask(
    taskId: TraceId,
    workerId: string,
    ttl: number,
  ): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  } {
    return withTransaction('claimTask', db =>
      executeClaimTaskInternal(db, taskId, workerId, ttl),
    )
  }

  /**
   * Report task success
   */
  static reportTaskSuccess(
    taskId: TraceId,
    resultVersionId: TraceId,
    workerId: string,
  ): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  } {
    return withTransaction('reportTaskSuccess', db =>
      executeReportTaskSuccessInternal(db, taskId, resultVersionId, workerId),
    )
  }

  /**
   * Report task failure
   */
  static reportTaskFailure(
    taskId: TraceId,
    errorVersionId: TraceId,
    workerId: string,
  ): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  } {
    return withTransaction('reportTaskFailure', db =>
      executeReportTaskFailureInternal(db, taskId, errorVersionId, workerId),
    )
  }

  /**
   * Schedule task for execution
   */
  static scheduleTaskForExecution(taskId: TraceId): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp?: number
    claimWorkerId?: string
    claimTtlSeconds?: number
  } {
    return withTransaction('scheduleTaskForExecution', db =>
      executeScheduleTaskForExecutionInternal(db, taskId),
    )
  }

  /**
   * Update node states in workflow
   */
  static updateNodeStates(
    revisionId: TraceId,
    nodeUpdates: Array<{
      nodeId: string
      dependencyStatus?: 'FRESH' | 'STALE'
      runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
      contextAssetHash: AssetId
      requiredTaskId?: TraceId
      lastInputsHash?: AssetId
    }>,
  ): { id: TraceId, status: string, createdAt: number, nodes: any[] } {
    return withTransaction('updateNodeStates', db =>
      executeUpdateNodeStatesInternal(db, revisionId, nodeUpdates),
    )
  }

  /**
   * Refresh task - reset SUCCEEDED or FAILED task back to PENDING
   */
  static refreshTask(taskId: TraceId): {
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number | null
    claimWorkerId: string | null
    claimTtlSeconds: number | null
  } {
    return withTransaction('refreshTask', db =>
      executeRefreshTaskInternal(db, taskId),
    )
  }

  /**
   * Fork a workflow revision (v14 Copy-on-Write)
   * External mutation that manages its own transaction
   *
   * This is the core primitive for v14 revision forking mechanism.
   * Combines both parts: duplicateWorkflowRevisionNodeStates + finalizeRevisionFork
   *
   * Transaction model:
   * - State copying: Runs outside transaction (can retry on failure)
   * - Pointer updates: Atomic transaction for Versions + Tasks updates
   *
   * @param data Fork parameters
   * @returns New revision ID
   */
  static forkRevision(data: {
    taskId: TraceId
    parentRevisionId: TraceId
    newRevisionId: TraceId
    timestamp: number
    commitMessage?: string
    triggerReason?: string
  }): TraceId {
    return withTransaction('forkRevision', (db) => {
      InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(db, {
        parentRevisionId: data.parentRevisionId,
        newRevisionId: data.newRevisionId,
      })
      InternalDatabaseOperations.finalizeRevisionFork(db, data)
      return data.newRevisionId
    })
  }
}

// ================================================================
// INTERNAL OPERATION IMPLEMENTATIONS
// ================================================================

/**
 * Internal implementation of workflow task claiming
 * Uses only internal operations - no transaction management
 */
function executeClaimWorkflowTaskInternal(
  db: Database,
  taskId: TraceId,
  workerId: string,
  ttl: number,
  revisionVersionId: TraceId,
  timestamp: number,
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
} {
  // 1. Verify this is a workflow task by checking if the action has a current workflow definition
  const task = InternalDatabaseOperations.getTask(db, taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  // Get the action task to check if it has a workflow definition
  const actionTask = InternalDatabaseOperations.getTask(
    db,
    task.action_id as TraceId,
  )
  if (!actionTask) {
    throw new Error(`Action task ${task.action_id} not found`)
  }

  // Check if action has a current workflow definition version
  if (!actionTask.current_version_id) {
    throw new Error(
      `Action ${task.action_id} does not have a current workflow definition`,
    )
  }

  // Verify the current version is a workflow definition
  const actionVersion = InternalDatabaseOperations.getVersion(
    db,
    actionTask.current_version_id as TraceId,
  )
  if (
    !actionVersion
    || actionVersion.version_type_tag !== 'WORKFLOW_DEFINITION'
  ) {
    throw new Error(
      `Action ${task.action_id} current version is not a workflow definition`,
    )
  }

  // 2. Claim the task using claim-specific method
  const now = Date.now()
  const expirationTime = now + ttl * 1000

  const { changedRows }
    = InternalDatabaseOperations.updateTaskExecutionStateForClaim(
      db,
      taskId,
      workerId,
      {
        runtimeStatus: 'RUNNING',
        claimTimestamp: now,
        claimWorkerId: workerId,
        claimTtlSeconds: ttl,
        expirationTime: expirationTime,
      },
    )

  if (changedRows === 0) {
    // Get current state to provide better error information
    const currentState = InternalDatabaseOperations.getTaskExecutionState(
      db,
      taskId,
    )
    if (!currentState) {
      throw new Error(`Task ${taskId} not found in TaskExecutionStates`)
    }
    throw new Error(
      `Task ${taskId} not available for claiming - current status: ${currentState.runtime_status}`,
    )
  }

  // 3. Create revision version
  InternalDatabaseOperations.createVersion(db, {
    versionId: revisionVersionId,
    taskId: taskId,
    versionType: 'REVISION',
    executedDefVersionId: task.current_version_id,
    timestamp: timestamp,
    userTag: 'workflow-revision',
    commitMessage: `Workflow revision for task ${taskId}`,
  })

  // 4. Update task's current version and active revision to point to new revision
  InternalDatabaseOperations.updateTaskCurrentVersion(
    db,
    taskId,
    revisionVersionId,
  )
  InternalDatabaseOperations.updateTaskActiveRevision(
    db,
    taskId,
    revisionVersionId,
  )

  return {
    taskId,
    runtimeStatus: 'RUNNING',
    claimTimestamp: now,
    claimWorkerId: workerId,
    claimTtlSeconds: ttl,
  }
}

/**
 * Internal implementation of computational task creation
 */
function executeCreateComputationalTaskInternal(
  db: Database,
  actionId: string,
  uniquenessHash: AssetId,
  taskId: TraceId,
  timestamp: number,
): { id: TraceId, actionId: string, inputsContentHash: string } {
  // 1. Create the task
  InternalDatabaseOperations.createTask(db, {
    taskId: taskId,
    scopeId: default_scope_id,
    actionId: actionId,
    inputsContentHash: uniquenessHash,
    name: `Computational task for ${actionId}`,
    timestamp: timestamp,
  })

  // 2. Create execution state
  InternalDatabaseOperations.createTaskExecutionState(db, {
    taskId: taskId,
    actionId: actionId,
    runtimeStatus: 'PENDING',
  })

  return {
    id: taskId,
    actionId: actionId,
    inputsContentHash: uniquenessHash,
  }
}

/**
 * Internal implementation of request execution
 */
function executeRequestExecutionInternal(
  db: Database,
  actionId: string,
  inputAssetId: AssetId,
  handleId: TraceId,
  workflowInstanceTaskId: TraceId,
  timestamp: number,
): void {
  // 1. Create execution handle
  InternalDatabaseOperations.createExecutionHandle(db, {
    handleId: handleId,
    taskId: workflowInstanceTaskId,
    createdAt: timestamp,
    createdBy: 'system',
    description: `Execution of ${actionId}`,
  })

  // 2. Create WI task
  InternalDatabaseOperations.createTask(db, {
    taskId: workflowInstanceTaskId,
    scopeId: default_scope_id,
    actionId: actionId,
    inputsContentHash: inputAssetId,
    name: `Execution of ${actionId}`,
    description: `Execution of workflow user action ${actionId}`,
    timestamp: timestamp,
  })

  // 3. Create execution state
  InternalDatabaseOperations.createTaskExecutionState(db, {
    taskId: workflowInstanceTaskId,
    actionId: actionId,
    runtimeStatus: 'PENDING',
  })
}

/**
 * Internal implementation of regular task claiming
 */
function executeClaimTaskInternal(
  db: Database,
  taskId: TraceId,
  workerId: string,
  ttl: number,
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
} {
  const now = Date.now()
  const expirationTime = now + ttl * 1000

  // Use the claim-specific method that checks task eligibility
  const { changedRows }
    = InternalDatabaseOperations.updateTaskExecutionStateForClaim(
      db,
      taskId,
      workerId,
      {
        runtimeStatus: 'RUNNING',
        claimTimestamp: now,
        claimWorkerId: workerId,
        claimTtlSeconds: ttl,
        expirationTime: expirationTime,
      },
    )

  if (changedRows === 0) {
    // Get current state to provide better error information
    const currentState = InternalDatabaseOperations.getTaskExecutionState(
      db,
      taskId,
    )
    if (!currentState) {
      throw new Error(`Task ${taskId} not found in TaskExecutionStates`)
    }
    throw new Error(
      `Task ${taskId} not available for claiming - current status: ${currentState.runtime_status}`,
    )
  }

  return {
    taskId,
    runtimeStatus: 'RUNNING',
    claimTimestamp: now,
    claimWorkerId: workerId,
    claimTtlSeconds: ttl,
  }
}

/**
 * Internal implementation of reporting task success
 */
function executeReportTaskSuccessInternal(
  db: Database,
  taskId: TraceId,
  resultVersionId: TraceId,
  workerId: string,
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
} {
  // Verify worker has lease and update to SUCCEEDED, clearing claim info automatically
  const { changedRows }
    = InternalDatabaseOperations.updateTaskExecutionStateWithWorkerCheck(
      db,
      taskId,
      workerId,
      {
        runtimeStatus: 'SUCCEEDED',
        claimTimestamp: null,
        claimWorkerId: null,
        claimTtlSeconds: null,
        expirationTime: null,
      },
    )

  if (changedRows === 0) {
    throw new Error(
      `Task ${taskId} not found or not owned by worker ${workerId} - lease may have expired`,
    )
  }

  // Update task's current_version_id to point to result version
  InternalDatabaseOperations.updateTaskCurrentVersion(
    db,
    taskId,
    resultVersionId,
  )

  // [EVENT BUS] Produce task_completed event within same transaction
  const eventProducer = new SqliteEventProducer()
  eventProducer.produce(
    'task_completed',
    {
      task_id: taskId,
      version_id: resultVersionId,
      worker_id: workerId,
    },
    db,
  )

  // Get current state for return value
  const state = InternalDatabaseOperations.getTaskExecutionState(
    db,
    taskId,
  )
  if (!state) {
    throw new Error(
      `Task execution state ${taskId} not found after success report`,
    )
  }

  return {
    taskId,
    runtimeStatus: 'SUCCEEDED',
    claimTimestamp: state.claim_timestamp,
    claimWorkerId: state.claim_worker_id,
    claimTtlSeconds: state.claim_ttl_seconds,
  }
}

/**
 * Internal implementation of reporting task failure
 */
function executeReportTaskFailureInternal(
  db: Database,
  taskId: TraceId,
  errorVersionId: TraceId,
  workerId: string,
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
} {
  // Verify worker has lease and update to FAILED, clearing claim info automatically
  const { changedRows }
    = InternalDatabaseOperations.updateTaskExecutionStateWithWorkerCheck(
      db,
      taskId,
      workerId,
      {
        runtimeStatus: 'FAILED',
        claimTimestamp: null,
        claimWorkerId: null,
        claimTtlSeconds: null,
        expirationTime: null,
      },
    )

  if (changedRows === 0) {
    throw new Error(
      `Task ${taskId} not found or not owned by worker ${workerId} - lease may have expired`,
    )
  }

  // Update task's current_version_id to point to error version
  InternalDatabaseOperations.updateTaskCurrentVersion(
    db,
    taskId,
    errorVersionId,
  )

  // [EVENT BUS] Produce task_failed event within same transaction
  const eventProducer = new SqliteEventProducer()
  eventProducer.produce(
    'task_failed',
    {
      task_id: taskId,
      version_id: errorVersionId,
      worker_id: workerId,
    },
    db,
  )

  // Get current state for return value
  const state = InternalDatabaseOperations.getTaskExecutionState(
    db,
    taskId,
  )
  if (!state) {
    throw new Error(
      `Task execution state ${taskId} not found after failure report`,
    )
  }

  return {
    taskId,
    runtimeStatus: 'FAILED',
    claimTimestamp: state.claim_timestamp,
    claimWorkerId: state.claim_worker_id,
    claimTtlSeconds: state.claim_ttl_seconds,
  }
}

/**
 * Internal implementation of scheduling task for execution
 */
function executeScheduleTaskForExecutionInternal(
  db: Database,
  taskId: TraceId,
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp?: number
  claimWorkerId?: string
  claimTtlSeconds?: number
} {
  // Get the task to find its action_id
  const task = InternalDatabaseOperations.getTask(db, taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  // Create or update execution state to PENDING (use upsert to handle existing records)
  db.prepare(
    `INSERT OR REPLACE INTO TaskExecutionStates (task_id, action_id, runtime_status, claim_timestamp, claim_worker_id, claim_ttl_seconds, expiration_time)
       VALUES (?, ?, 'PENDING', NULL, NULL, NULL, NULL)`,
  ).run(taskId, task.action_id)

  return {
    taskId,
    runtimeStatus: 'PENDING',
    claimTimestamp: undefined,
    claimWorkerId: undefined,
    claimTtlSeconds: undefined,
  }
}

/**
 * Internal implementation of updating node states
 */
function executeUpdateNodeStatesInternal(
  db: Database,
  revisionId: TraceId,
  nodeUpdates: Array<{
    nodeId: string
    dependencyStatus?: 'FRESH' | 'STALE'
    runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
    contextAssetHash: AssetId
    requiredTaskId?: TraceId
    lastInputsHash?: AssetId
    metaAssetHash?: AssetId
  }>,
): { id: TraceId, status: string, createdAt: number, nodes: any[] } {
  // Process each node update
  console.log(
    `🔍 [DB_OPS] executeUpdateNodeStatesInternal: Processing ${nodeUpdates.length} updates for revisionId=${revisionId}`,
  )

  for (const update of nodeUpdates) {
    console.log(
      `🔍 [DB_OPS] Processing update: nodeId=${update.nodeId}, lastInputsHash=${update.lastInputsHash || 'undefined'}`,
    )

    const contextHash = update.contextAssetHash

    // Upsert node state
    // Note: We use a sentinel value for "not provided" vs "explicitly NULL"
    // - undefined -> use sentinel '__KEEP__' to preserve existing value
    // - null -> use NULL to clear the field
    // - value -> use the value
    const hasRequiredTaskId = update.requiredTaskId !== undefined
    const requiredTaskIdValue = hasRequiredTaskId
      ? update.requiredTaskId
      : '__KEEP__'

    const hasLastInputsHash = update.lastInputsHash !== undefined
    const lastInputsHashValue = hasLastInputsHash
      ? update.lastInputsHash
      : '__KEEP__'

    const hasMetaAssetHash = update.metaAssetHash !== undefined
    const metaAssetHashValue = hasMetaAssetHash
      ? update.metaAssetHash
      : '__KEEP__'

    console.log(
      `🔍 [DB_OPS] SQL values: lastInputsHash=${lastInputsHashValue} (from ${update.lastInputsHash})`,
    )

    const query = `INSERT INTO WorkflowRevisionNodeStates (
           workflow_revision_id, node_id_in_workflow, context_asset_hash,
           dependency_status, runtime_status, required_task_id, last_inputs_hash, meta_asset_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_revision_id, node_id_in_workflow, context_asset_hash)
         DO UPDATE SET
           dependency_status = COALESCE(excluded.dependency_status, dependency_status),
           runtime_status = COALESCE(excluded.runtime_status, runtime_status),
           required_task_id = CASE WHEN excluded.required_task_id = '__KEEP__' THEN required_task_id ELSE excluded.required_task_id END,
           last_inputs_hash = CASE WHEN excluded.last_inputs_hash = '__KEEP__' THEN last_inputs_hash ELSE excluded.last_inputs_hash END,
           meta_asset_hash = CASE WHEN excluded.meta_asset_hash = '__KEEP__' THEN meta_asset_hash ELSE excluded.meta_asset_hash END`

    const params = [
      revisionId,
      update.nodeId,
      contextHash,
      update.dependencyStatus || 'STALE',
      update.runtimeStatus,
      requiredTaskIdValue,
      lastInputsHashValue,
      metaAssetHashValue,
    ]

    console.log(`🔍 [DB_OPS] Executing SQL with params:`, params)

    db.prepare(query).run(...params)

    console.log(
      `✅ [DB_OPS] Successfully upserted node ${update.nodeId}`,
    )
  }

  // Get revision timestamp for response
  const revisionRow = db.prepare(
    'SELECT timestamp_created FROM Versions WHERE version_id = ?',
  ).get(revisionId) as { timestamp_created: number } | undefined

  if (!revisionRow) {
    throw new Error(
      'Failed to fetch revision timestamp for updateNodeStates.',
    )
  }

  return {
    id: revisionId,
    status: 'PROCESSING_UPDATES',
    createdAt: revisionRow.timestamp_created,
    nodes: [],
  }
}

/**
 * Internal implementation of refreshing a task
 */
export function executeRefreshTaskInternal(
  db: Database,
  taskId: TraceId,
  options?: { clearVersion?: boolean },
): {
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number | null
  claimWorkerId: string | null
  claimTtlSeconds: number | null
} {
  // 1. Check if task exists first
  const currentState = InternalDatabaseOperations.getTaskExecutionState(
    db,
    taskId,
  )
  if (!currentState) {
    throw new Error(`Task ${taskId} not found in TaskExecutionStates`)
  }

  // 2. Atomically update the task state only if it's in SUCCEEDED or FAILED state
  // This prevents race conditions by checking the status in the WHERE clause
  const { changedRows }
    = InternalDatabaseOperations.updateTaskExecutionStateWithStatusCheck(
      db,
      taskId,
      ['SUCCEEDED', 'FAILED'], // Only allow refresh from these states
      {
        runtimeStatus: 'PENDING',
        claimTimestamp: null,
        claimWorkerId: null,
        claimTtlSeconds: null,
        expirationTime: null,
      },
    )

  if (changedRows === 0) {
    // Get current state to provide better error message
    const latestState = InternalDatabaseOperations.getTaskExecutionState(
      db,
      taskId,
    )
    if (!latestState) {
      throw new Error(`Task ${taskId} not found in TaskExecutionStates`)
    }
    throw new Error(
      `Task ${taskId} is in ${latestState.runtime_status} state. Can only refresh tasks in SUCCEEDED or FAILED states.`,
    )
  }

  // 3. Optionally clear current_version_id to make task discoverable in findRunnableTasks
  // Default: false (for backward compatibility - allows "secret" claiming before other workers discover it)
  // Set to true: for rerun operations where task should be publicly discoverable
  if (options?.clearVersion) {
    db.prepare(
      `UPDATE Tasks SET current_version_id = NULL WHERE task_id = ?`,
    ).run(taskId)
  }

  return {
    taskId,
    runtimeStatus: 'PENDING',
    claimTimestamp: null,
    claimWorkerId: null,
    claimTtlSeconds: null,
  }
}

// ================================================================
// QUERY OPERATIONS (no serialization needed)
// ================================================================

/**
 * Query operations that don't need serialization (reads are concurrent in SQLite)
 */
export class DatabaseQueries {
  static findRunnableTasks(
    actionId?: string,
    limit: number = 50,
  ): Array<{ taskId: TraceId, runtimeStatus: string, actionId: string }> {
    const db = getDB()

    let query = `
        SELECT task_id, runtime_status, action_id
        FROM TaskExecutionStates
        WHERE runtime_status = 'PENDING'
      `
    const params: any[] = []

    if (actionId) {
      query += ` AND action_id = ?`
      params.push(actionId)
    }

    query += ` ORDER BY task_id LIMIT ?`
    params.push(limit)

    const rows = db.prepare(query).all(...params) as any[]
    return rows.map(row => ({
      taskId: row.task_id,
      runtimeStatus: row.runtime_status,
      actionId: row.action_id,
    }))
  }

  static getTaskWithCurrentVersion(taskId: TraceId): any {
    const db = getDB()
    return InternalDatabaseOperations.getTask(db, taskId)
  }

  /**
   * Get workflow task and current revision from execution handle
   * Common pattern used by v14 revision forking mutations
   *
   * @returns { wiTaskId: TraceId, currentRevisionId: TraceId }
   */
  static getWorkflowTaskFromHandle(handleId: TraceId): {
    wiTaskId: TraceId
    currentRevisionId: TraceId
  } {
    const db = getDB()

    // Step 1: Get WI Task from Handle
    const handleRow = db.prepare(
      `SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`,
    ).get(handleId) as any
    if (!handleRow) {
      throw new Error(`Handle ${handleId} not found`)
    }

    const wiTaskId = handleRow.task_id

    // Step 2: Get active REVISION version (O(1) lookup via active_revision_id)
    const taskRow = db.prepare(
      `SELECT active_revision_id FROM Tasks WHERE task_id = ?`,
    ).get(wiTaskId) as any
    if (!taskRow?.active_revision_id) {
      throw new Error(`WI Task ${wiTaskId} has no active revision`)
    }

    return {
      wiTaskId,
      currentRevisionId: taskRow.active_revision_id,
    }
  }
}
