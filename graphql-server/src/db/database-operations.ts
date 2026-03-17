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

import type { AssetId } from 'playtiss'
import { default_scope_id } from 'playtiss'
import type { TraceId } from 'playtiss/types/trace_id'
import sqlite3 from 'sqlite3'
import { getDB } from '../db.js'
import { SqliteEventProducer } from '../event-bus/sqlite-producer.js'
import { serializeMutation } from './mutation-serializer.js'

// ================================================================
// INTERNAL OPERATIONS (run within transactions)
// ================================================================

/**
 * Internal operation context - tracks transaction state
 */
export interface InternalOperationContext {
  db: sqlite3.Database
  transactionId: string
}

/**
 * Low-level database operations that run within transactions
 * These are the "internal operations" that don't manage their own transactions
 */
export class InternalDatabaseOperations {
  /**
   * Create a task record
   */
  static async createTask(
    ctx: InternalOperationContext,
    data: {
      taskId: TraceId
      scopeId: string
      actionId: string
      inputsContentHash?: string
      name?: string
      description?: string
      timestamp: number
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.taskId,
          data.scopeId,
          data.actionId,
          data.inputsContentHash,
          data.name,
          data.description,
          data.timestamp,
        ],
        function (err) {
          if (err) reject(new Error(`Failed to create task: ${err.message}`))
          else resolve()
        },
      )
    })
  }

  /**
   * Create a version record
   */
  static async createVersion(
    ctx: InternalOperationContext,
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
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO Versions (version_id, task_id, version_type_tag, asset_content_hash, 
                               parent_version_id, executed_def_version_id, timestamp_created, 
                               user_given_tag, commit_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.versionId,
          data.taskId,
          data.versionType,
          data.assetContentHash,
          data.parentVersionId,
          data.executedDefVersionId,
          data.timestamp,
          data.userTag,
          data.commitMessage,
        ],
        function (err) {
          if (err)
            reject(new Error(`Failed to create version: ${err.message}`))
          else resolve()
        },
      )
    })
  }

  /**
   * Update task's current version
   */
  static async updateTaskCurrentVersion(
    ctx: InternalOperationContext,
    taskId: TraceId,
    versionId: TraceId,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
        [versionId, taskId],
        function (err) {
          if (err)
            reject(
              new Error(`Failed to update task current version: ${err.message}`),
            )
          else resolve()
        },
      )
    })
  }

  /**
   * Update task's active revision ID (points to latest REVISION version)
   */
  static async updateTaskActiveRevision(
    ctx: InternalOperationContext,
    taskId: TraceId,
    revisionId: TraceId,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `UPDATE Tasks SET active_revision_id = ? WHERE task_id = ?`,
        [revisionId, taskId],
        function (err) {
          if (err)
            reject(
              new Error(`Failed to update task active revision: ${err.message}`),
            )
          else resolve()
        },
      )
    })
  }

  /**
   * Get active revision ID for a task (O(1) lookup)
   * Returns the latest REVISION version ID for the given task
   */
  static async getActiveRevisionId(
    ctx: InternalOperationContext,
    taskId: TraceId,
  ): Promise<TraceId | null> {
    return new Promise((resolve, reject) => {
      ctx.db.get(
        `SELECT active_revision_id FROM Tasks WHERE task_id = ?`,
        [taskId],
        (err, row: any) => {
          if (err)
            reject(new Error(`Failed to get active revision: ${err.message}`))
          else resolve(row?.active_revision_id || null)
        },
      )
    })
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
   * @param ctx Transaction context (state copy uses ctx.db but not in transaction)
   * @param data Fork parameters
   */
  /**
   * Part 1: Duplicate workflow revision node states (NON-transactional, retryable)
   * This is the state copying phase that can be done outside transactions
   *
   * v14.1 Update: Also copies PipelineMergeAccumulator to preserve merge node state
   */
  static async duplicateWorkflowRevisionNodeStates(
    ctx: InternalOperationContext,
    data: {
      parentRevisionId: TraceId
      newRevisionId: TraceId
    },
  ): Promise<void> {
    // Copy WorkflowRevisionNodeStates
    await new Promise<void>((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO WorkflowRevisionNodeStates (
          workflow_revision_id, node_id_in_workflow, context_asset_hash,
          required_task_id, last_used_version_id, last_inputs_hash,
          dependency_status, runtime_status, error_message
        )
        SELECT
          ? AS new_revision_id,
          node_id_in_workflow, context_asset_hash,
          required_task_id, last_used_version_id, last_inputs_hash,
          dependency_status, runtime_status, error_message
        FROM WorkflowRevisionNodeStates
        WHERE workflow_revision_id = ?`,
        [data.newRevisionId, data.parentRevisionId],
        function (err) {
          if (err)
            reject(
              new Error(
                `Failed to copy workflow revision node states: ${err.message}`,
              ),
            )
          else resolve()
        },
      )
    })

    // Copy PipelineMergeAccumulator (v14.1 - preserve merge node state on fork)
    await new Promise<void>((resolve) => {
      ctx.db.run(
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
        [data.newRevisionId, data.parentRevisionId],
        function (err) {
          // Ignore errors if no merge accumulator exists (this is optional data)
          if (err) {
            console.warn(
              `Note: Could not copy merge accumulator (might not exist): ${err.message}`,
            )
          }
          // Always resolve - merge accumulator copy is optional
          resolve()
        },
      )
    })
  }

  /**
   * Update node runtime status (preserves dependency status)
   * Used by player input mutations and rerun operations
   */
  static async updateNodeRuntimeStatus(
    ctx: InternalOperationContext,
    data: {
      workflowRevisionId: TraceId
      nodeId: string
      contextAssetHash: AssetId
      runtimeStatus: 'IDLE' | 'RUNNING' | 'FAILED'
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `UPDATE WorkflowRevisionNodeStates
         SET runtime_status = ?
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
        [
          data.runtimeStatus,
          data.workflowRevisionId,
          data.nodeId,
          data.contextAssetHash,
        ],
        function (err) {
          if (err)
            return reject(
              new Error(`Failed to update node runtime status: ${err.message}`),
            )
          if (this.changes === 0) {
            return reject(
              new Error(
                `Node ${data.nodeId} not found in workflow revision ${data.workflowRevisionId}`,
              ),
            )
          }
          resolve()
        },
      )
    })
  }

  /**
   * Part 2: Finalize revision fork (MUST be in transaction)
   * Creates Versions record and updates Tasks.current_version_id pointer
   * Assumes caller has already begun transaction
   */
  static async finalizeRevisionFork(
    ctx: InternalOperationContext,
    data: {
      taskId: TraceId
      parentRevisionId: TraceId
      newRevisionId: TraceId
      timestamp: number
      commitMessage?: string
      triggerReason?: string
    },
  ): Promise<void> {
    // Create Versions record
    await new Promise<void>((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO Versions (
          version_id, task_id, version_type_tag,
          parent_version_id, timestamp_created, commit_message
        ) VALUES (?, ?, 'REVISION', ?, ?, ?)`,
        [
          data.newRevisionId,
          data.taskId,
          data.parentRevisionId,
          data.timestamp,
          data.commitMessage || data.triggerReason || 'Revision fork',
        ],
        function (err) {
          if (err)
            reject(
              new Error(`Failed to create revision version: ${err.message}`),
            )
          else resolve()
        },
      )
    })

    // Update Tasks.current_version_id AND active_revision_id pointers
    // Both point to the new revision since this is a fork operation
    await new Promise<void>((resolve, reject) => {
      ctx.db.run(
        `UPDATE Tasks SET current_version_id = ?, active_revision_id = ? WHERE task_id = ?`,
        [data.newRevisionId, data.newRevisionId, data.taskId],
        function (err) {
          if (err)
            reject(new Error(`Failed to update task pointers: ${err.message}`))
          else resolve()
        },
      )
    })
  }

  /**
   * Create task execution state
   */
  static async createTaskExecutionState(
    ctx: InternalOperationContext,
    data: {
      taskId: TraceId
      actionId: string
      runtimeStatus: string
      claimTimestamp?: number
      claimWorkerId?: string
      claimTtlSeconds?: number
      expirationTime?: number
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO TaskExecutionStates (task_id, action_id, runtime_status, claim_timestamp, 
                                         claim_worker_id, claim_ttl_seconds, expiration_time)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.taskId,
          data.actionId,
          data.runtimeStatus,
          data.claimTimestamp,
          data.claimWorkerId,
          data.claimTtlSeconds,
          data.expirationTime,
        ],
        function (err) {
          if (err)
            reject(
              new Error(`Failed to create task execution state: ${err.message}`),
            )
          else resolve()
        },
      )
    })
  }

  /**
   * Update task execution state with worker verification (for completing tasks)
   */
  static async updateTaskExecutionStateWithWorkerCheck(
    ctx: InternalOperationContext,
    taskId: TraceId,
    workerId: string,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): Promise<{ changedRows: number }> {
    return new Promise((resolve, reject) => {
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
        return resolve({ changedRows: 0 })
      }

      // Add WHERE clause to verify worker ownership and lease hasn't expired
      values.push(taskId)
      values.push(workerId)
      values.push(Date.now()) // Current timestamp to check expiration

      ctx.db.run(
        `UPDATE TaskExecutionStates SET ${setParts.join(', ')} 
         WHERE task_id = ? AND claim_worker_id = ? AND expiration_time > ?`,
        values,
        function (err) {
          if (err)
            reject(
              new Error(`Failed to update task execution state: ${err.message}`),
            )
          else resolve({ changedRows: this.changes })
        },
      )
    })
  }

  /**
   * Update task execution state (for claiming/completing tasks)
   */
  static async updateTaskExecutionState(
    ctx: InternalOperationContext,
    taskId: TraceId,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): Promise<{ changedRows: number }> {
    return new Promise((resolve, reject) => {
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
        return resolve({ changedRows: 0 })
      }

      values.push(taskId)

      ctx.db.run(
        `UPDATE TaskExecutionStates SET ${setParts.join(', ')} WHERE task_id = ?`,
        values,
        function (err) {
          if (err)
            reject(
              new Error(`Failed to update task execution state: ${err.message}`),
            )
          else resolve({ changedRows: this.changes })
        },
      )
    })
  }

  /**
   * Update task execution state with status check (for refresh operations)
   */
  static async updateTaskExecutionStateWithStatusCheck(
    ctx: InternalOperationContext,
    taskId: TraceId,
    fromStatuses: string[],
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number | null
      claimWorkerId?: string | null
      claimTtlSeconds?: number | null
      expirationTime?: number | null
    },
  ): Promise<{ changedRows: number }> {
    return new Promise((resolve, reject) => {
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
        return resolve({ changedRows: 0 })
      }

      // Add WHERE clause to check current status is one of the allowed states
      const statusPlaceholders = fromStatuses.map(() => '?').join(', ')
      values.push(taskId)
      values.push(...fromStatuses)

      ctx.db.run(
        `UPDATE TaskExecutionStates SET ${setParts.join(', ')}
         WHERE task_id = ? AND runtime_status IN (${statusPlaceholders})`,
        values,
        function (err) {
          if (err)
            reject(
              new Error(
                `Failed to update task execution state with status check: ${err.message}`,
              ),
            )
          else resolve({ changedRows: this.changes })
        },
      )
    })
  }

  /**
   * Update task execution state for claiming (with claim eligibility check)
   */
  static async updateTaskExecutionStateForClaim(
    ctx: InternalOperationContext,
    taskId: TraceId,
    workerId: string,
    updates: {
      runtimeStatus?: string
      claimTimestamp?: number
      claimWorkerId?: string
      claimTtlSeconds?: number
      expirationTime?: number
    },
  ): Promise<{ changedRows: number }> {
    return new Promise((resolve, reject) => {
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
        return resolve({ changedRows: 0 })
      }

      const currentTime = updates.claimTimestamp || Date.now()
      values.push(taskId, currentTime, workerId, currentTime)

      ctx.db.run(
        `UPDATE TaskExecutionStates SET ${setParts.join(', ')}
         WHERE task_id = ? 
         AND (runtime_status = 'PENDING' OR 
              (runtime_status = 'RUNNING' AND claim_timestamp IS NOT NULL AND (? - claim_timestamp) / 1000.0 > claim_ttl_seconds) OR
              (runtime_status = 'RUNNING' AND claim_worker_id = ? AND claim_timestamp IS NOT NULL AND (? - claim_timestamp) / 1000.0 <= claim_ttl_seconds))`,
        values,
        function (err) {
          if (err)
            reject(
              new Error(`Failed to claim task execution state: ${err.message}`),
            )
          else resolve({ changedRows: this.changes })
        },
      )
    })
  }

  /**
   * Create execution handle
   */
  static async createExecutionHandle(
    ctx: InternalOperationContext,
    data: {
      handleId: TraceId
      taskId: TraceId
      createdAt: number
      createdBy: string
      description?: string
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.db.run(
        `INSERT INTO ExecutionHandles (handle_id, task_id, created_at, created_by, description)
         VALUES (?, ?, ?, ?, ?)`,
        [
          data.handleId,
          data.taskId,
          data.createdAt,
          data.createdBy,
          data.description,
        ],
        function (err) {
          if (err)
            reject(
              new Error(`Failed to create execution handle: ${err.message}`),
            )
          else resolve()
        },
      )
    })
  }

  /**
   * Query operations (can be used both internally and externally)
   */

  static async getTask(db: sqlite3.Database, taskId: TraceId): Promise<any> {
    return new Promise((resolve, reject) => {
      db.get(`SELECT * FROM Tasks WHERE task_id = ?`, [taskId], (err, row) => {
        if (err) reject(new Error(`Failed to get task: ${err.message}`))
        else resolve(row)
      })
    })
  }

  static async getVersion(
    db: sqlite3.Database,
    versionId: TraceId,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM Versions WHERE version_id = ?`,
        [versionId],
        (err, row) => {
          if (err) reject(new Error(`Failed to get version: ${err.message}`))
          else resolve(row)
        },
      )
    })
  }

  static async getTaskExecutionState(
    db: sqlite3.Database,
    taskId: TraceId,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM TaskExecutionStates WHERE task_id = ?`,
        [taskId],
        (err, row) => {
          if (err)
            reject(
              new Error(`Failed to get task execution state: ${err.message}`),
            )
          else resolve(row)
        },
      )
    })
  }

  /**
   * Fetch existing task by uniqueness parameters (scope, action, inputs hash)
   * Used for idempotent task creation and race condition handling
   */
  static async fetchTaskByUniqueness(
    db: sqlite3.Database,
    actionId: string,
    uniquenessHash: AssetId,
  ): Promise<any | null> {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT t.task_id, t.action_id, t.name, t.description, t.timestamp_created, t.current_version_id,
                v.version_id, v.version_type_tag, v.asset_content_hash, v.timestamp_created as version_timestamp, v.commit_message
         FROM Tasks t
         LEFT JOIN Versions v ON t.current_version_id = v.version_id
         WHERE t.scope_id = ? AND t.action_id = ? AND t.inputs_content_hash = ?`,
        [default_scope_id, actionId, uniquenessHash],
        (err, row) => {
          if (err) reject(err)
          else resolve(row || null)
        },
      )
    })
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
  static async claimWorkflowTask(
    taskId: TraceId,
    workerId: string,
    ttl: number,
    revisionVersionId: TraceId,
    timestamp: number,
  ): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  }> {
    return serializeMutation('claimWorkflowTask', async () => {
      const db = getDB()
      const transactionId = `claim_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            // Execute the complex operation using internal operations
            executeClaimWorkflowTaskInternal(
              ctx,
              taskId,
              workerId,
              ttl,
              revisionVersionId,
              timestamp,
            )
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Create a computational task and schedule for execution
   */
  static async createComputationalTask(
    actionId: string,
    uniquenessHash: AssetId,
    taskId: TraceId,
    timestamp: number,
  ): Promise<{ id: TraceId, actionId: string, inputsContentHash: string }> {
    return serializeMutation('createComputationalTask', async () => {
      const db = getDB()
      const transactionId = `create_task_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeCreateComputationalTaskInternal(
              ctx,
              actionId,
              uniquenessHash,
              taskId,
              timestamp,
            )
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Request execution and return handle ID
   */
  static async requestExecution(
    actionId: string,
    inputAssetId: AssetId,
    handleId: TraceId,
    workflowInstanceTaskId: TraceId,
    timestamp: number,
  ): Promise<TraceId> {
    return serializeMutation('requestExecution', async () => {
      const db = getDB()
      const transactionId = `request_execution_${handleId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeRequestExecutionInternal(
              ctx,
              actionId,
              inputAssetId,
              handleId,
              workflowInstanceTaskId,
              timestamp,
            )
              .then(() => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(handleId)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Claim a regular computational task
   */
  static async claimTask(
    taskId: TraceId,
    workerId: string,
    ttl: number,
  ): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  }> {
    return serializeMutation('claimTask', async () => {
      const db = getDB()
      const transactionId = `claim_task_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeClaimTaskInternal(ctx, taskId, workerId, ttl)
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Report task success
   */
  static async reportTaskSuccess(
    taskId: TraceId,
    resultVersionId: TraceId,
    workerId: string,
  ): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  }> {
    return serializeMutation('reportTaskSuccess', async () => {
      const db = getDB()
      const transactionId = `report_success_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeReportTaskSuccessInternal(
              ctx,
              taskId,
              resultVersionId,
              workerId,
            )
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Report task failure
   */
  static async reportTaskFailure(
    taskId: TraceId,
    errorVersionId: TraceId,
    workerId: string,
  ): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number
    claimWorkerId: string
    claimTtlSeconds: number
  }> {
    return serializeMutation('reportTaskFailure', async () => {
      const db = getDB()
      const transactionId = `report_failure_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeReportTaskFailureInternal(
              ctx,
              taskId,
              errorVersionId,
              workerId,
            )
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Schedule task for execution
   */
  static async scheduleTaskForExecution(taskId: TraceId): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp?: number
    claimWorkerId?: string
    claimTtlSeconds?: number
  }> {
    return serializeMutation('scheduleTaskForExecution', async () => {
      const db = getDB()
      const transactionId = `schedule_task_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeScheduleTaskForExecutionInternal(ctx, taskId)
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Update node states in workflow
   */
  static async updateNodeStates(
    revisionId: TraceId,
    nodeUpdates: Array<{
      nodeId: string
      dependencyStatus?: 'FRESH' | 'STALE'
      runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
      contextAssetHash: AssetId
      requiredTaskId?: TraceId
      lastInputsHash?: AssetId
    }>,
  ): Promise<{ id: TraceId, status: string, createdAt: number, nodes: any[] }> {
    return serializeMutation('updateNodeStates', async () => {
      const db = getDB()
      const transactionId = `update_node_states_${revisionId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeUpdateNodeStatesInternal(ctx, revisionId, nodeUpdates)
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
  }

  /**
   * Refresh task - reset SUCCEEDED or FAILED task back to PENDING
   */
  static async refreshTask(taskId: TraceId): Promise<{
    taskId: TraceId
    runtimeStatus: string
    claimTimestamp: number | null
    claimWorkerId: string | null
    claimTtlSeconds: number | null
  }> {
    return serializeMutation('refreshTask', async () => {
      const db = getDB()
      const transactionId = `refresh_task_${taskId}_${Date.now()}`

      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            const ctx: InternalOperationContext = { db, transactionId }

            executeRefreshTaskInternal(ctx, taskId)
              .then((result) => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) reject(commitErr)
                  else resolve(result)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
    })
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
   * @returns Promise<TraceId> New revision ID
   */
  static async forkRevision(data: {
    taskId: TraceId
    parentRevisionId: TraceId
    newRevisionId: TraceId
    timestamp: number
    commitMessage?: string
    triggerReason?: string
  }): Promise<TraceId> {
    return serializeMutation('forkRevision', async () => {
      const db = getDB()
      const ctx: InternalOperationContext = {
        db,
        transactionId: 'forkRevision',
      }

      // Part 1: Duplicate node states (outside transaction)
      await InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(
        ctx,
        {
          parentRevisionId: data.parentRevisionId,
          newRevisionId: data.newRevisionId,
        },
      )

      // Part 2: Finalize fork in transaction
      return new Promise<TraceId>((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE;', (beginErr) => {
            if (beginErr) return reject(beginErr)

            InternalDatabaseOperations.finalizeRevisionFork(ctx, data)
              .then(() => {
                db.run('COMMIT;', (commitErr) => {
                  if (commitErr) return reject(commitErr)
                  resolve(data.newRevisionId)
                })
              })
              .catch((error) => {
                db.run('ROLLBACK;', () => reject(error))
              })
          })
        })
      })
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
async function executeClaimWorkflowTaskInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
  workerId: string,
  ttl: number,
  revisionVersionId: TraceId,
  timestamp: number,
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
}> {
  // 1. Verify this is a workflow task by checking if the action has a current workflow definition
  const task = await InternalDatabaseOperations.getTask(ctx.db, taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  // Get the action task to check if it has a workflow definition
  const actionTask = await InternalDatabaseOperations.getTask(
    ctx.db,
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
  const actionVersion = await InternalDatabaseOperations.getVersion(
    ctx.db,
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
    = await InternalDatabaseOperations.updateTaskExecutionStateForClaim(
      ctx,
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
    const currentState = await InternalDatabaseOperations.getTaskExecutionState(
      ctx.db,
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
  await InternalDatabaseOperations.createVersion(ctx, {
    versionId: revisionVersionId,
    taskId: taskId,
    versionType: 'REVISION',
    executedDefVersionId: task.current_version_id,
    timestamp: timestamp,
    userTag: 'workflow-revision',
    commitMessage: `Workflow revision for task ${taskId}`,
  })

  // 4. Update task's current version and active revision to point to new revision
  await InternalDatabaseOperations.updateTaskCurrentVersion(
    ctx,
    taskId,
    revisionVersionId,
  )
  await InternalDatabaseOperations.updateTaskActiveRevision(
    ctx,
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
async function executeCreateComputationalTaskInternal(
  ctx: InternalOperationContext,
  actionId: string,
  uniquenessHash: AssetId,
  taskId: TraceId,
  timestamp: number,
): Promise<{ id: TraceId, actionId: string, inputsContentHash: string }> {
  // 1. Create the task
  await InternalDatabaseOperations.createTask(ctx, {
    taskId: taskId,
    scopeId: default_scope_id,
    actionId: actionId,
    inputsContentHash: uniquenessHash,
    name: `Computational task for ${actionId}`,
    timestamp: timestamp,
  })

  // 2. Create execution state
  await InternalDatabaseOperations.createTaskExecutionState(ctx, {
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
async function executeRequestExecutionInternal(
  ctx: InternalOperationContext,
  actionId: string,
  inputAssetId: AssetId,
  handleId: TraceId,
  workflowInstanceTaskId: TraceId,
  timestamp: number,
): Promise<void> {
  // 1. Create execution handle
  await InternalDatabaseOperations.createExecutionHandle(ctx, {
    handleId: handleId,
    taskId: workflowInstanceTaskId,
    createdAt: timestamp,
    createdBy: 'system',
    description: `Execution of ${actionId}`,
  })

  // 2. Create WI task
  await InternalDatabaseOperations.createTask(ctx, {
    taskId: workflowInstanceTaskId,
    scopeId: default_scope_id,
    actionId: actionId,
    inputsContentHash: inputAssetId,
    name: `Execution of ${actionId}`,
    description: `Execution of workflow user action ${actionId}`,
    timestamp: timestamp,
  })

  // 3. Create execution state
  await InternalDatabaseOperations.createTaskExecutionState(ctx, {
    taskId: workflowInstanceTaskId,
    actionId: actionId,
    runtimeStatus: 'PENDING',
  })
}

/**
 * Internal implementation of regular task claiming
 */
async function executeClaimTaskInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
  workerId: string,
  ttl: number,
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
}> {
  const now = Date.now()
  const expirationTime = now + ttl * 1000

  // Use the claim-specific method that checks task eligibility
  const { changedRows }
    = await InternalDatabaseOperations.updateTaskExecutionStateForClaim(
      ctx,
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
    const currentState = await InternalDatabaseOperations.getTaskExecutionState(
      ctx.db,
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
async function executeReportTaskSuccessInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
  resultVersionId: TraceId,
  workerId: string,
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
}> {
  // Verify worker has lease and update to SUCCEEDED, clearing claim info automatically
  const { changedRows }
    = await InternalDatabaseOperations.updateTaskExecutionStateWithWorkerCheck(
      ctx,
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
  await InternalDatabaseOperations.updateTaskCurrentVersion(
    ctx,
    taskId,
    resultVersionId,
  )

  // [EVENT BUS] Produce task_completed event within same transaction
  const eventProducer = new SqliteEventProducer()
  await eventProducer.produce(
    'task_completed',
    {
      task_id: taskId,
      version_id: resultVersionId,
      worker_id: workerId,
    },
    ctx.db,
  )

  // Get current state for return value
  const state = await InternalDatabaseOperations.getTaskExecutionState(
    ctx.db,
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
async function executeReportTaskFailureInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
  errorVersionId: TraceId,
  workerId: string,
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number
  claimWorkerId: string
  claimTtlSeconds: number
}> {
  // Verify worker has lease and update to FAILED, clearing claim info automatically
  const { changedRows }
    = await InternalDatabaseOperations.updateTaskExecutionStateWithWorkerCheck(
      ctx,
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
  await InternalDatabaseOperations.updateTaskCurrentVersion(
    ctx,
    taskId,
    errorVersionId,
  )

  // [EVENT BUS] Produce task_failed event within same transaction
  const eventProducer = new SqliteEventProducer()
  await eventProducer.produce(
    'task_failed',
    {
      task_id: taskId,
      version_id: errorVersionId,
      worker_id: workerId,
    },
    ctx.db,
  )

  // Get current state for return value
  const state = await InternalDatabaseOperations.getTaskExecutionState(
    ctx.db,
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
async function executeScheduleTaskForExecutionInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp?: number
  claimWorkerId?: string
  claimTtlSeconds?: number
}> {
  // Get the task to find its action_id
  const task = await InternalDatabaseOperations.getTask(ctx.db, taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  // Create or update execution state to PENDING (use upsert to handle existing records)
  await new Promise<void>((resolve, reject) => {
    ctx.db.run(
      `INSERT OR REPLACE INTO TaskExecutionStates (task_id, action_id, runtime_status, claim_timestamp, claim_worker_id, claim_ttl_seconds, expiration_time)
       VALUES (?, ?, 'PENDING', NULL, NULL, NULL, NULL)`,
      [taskId, task.action_id],
      function (err) {
        if (err)
          reject(
            new Error(`Failed to schedule task execution state: ${err.message}`),
          )
        else resolve()
      },
    )
  })

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
async function executeUpdateNodeStatesInternal(
  ctx: InternalOperationContext,
  revisionId: TraceId,
  nodeUpdates: Array<{
    nodeId: string
    dependencyStatus?: 'FRESH' | 'STALE'
    runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
    contextAssetHash: AssetId
    requiredTaskId?: TraceId
    lastInputsHash?: AssetId
  }>,
): Promise<{ id: TraceId, status: string, createdAt: number, nodes: any[] }> {
  // Process each node update
  console.log(
    `🔍 [DB_OPS] executeUpdateNodeStatesInternal: Processing ${nodeUpdates.length} updates for revisionId=${revisionId}`,
  )

  for (const update of nodeUpdates) {
    console.log(
      `🔍 [DB_OPS] Processing update: nodeId=${update.nodeId}, lastInputsHash=${update.lastInputsHash || 'undefined'}`,
    )

    await new Promise<void>((resolve, reject) => {
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

      console.log(
        `🔍 [DB_OPS] SQL values: lastInputsHash=${lastInputsHashValue} (from ${update.lastInputsHash})`,
      )

      const query = `INSERT INTO WorkflowRevisionNodeStates (
           workflow_revision_id, node_id_in_workflow, context_asset_hash,
           dependency_status, runtime_status, required_task_id, last_inputs_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_revision_id, node_id_in_workflow, context_asset_hash)
         DO UPDATE SET
           dependency_status = COALESCE(excluded.dependency_status, dependency_status),
           runtime_status = COALESCE(excluded.runtime_status, runtime_status),
           required_task_id = CASE WHEN excluded.required_task_id = '__KEEP__' THEN required_task_id ELSE excluded.required_task_id END,
           last_inputs_hash = CASE WHEN excluded.last_inputs_hash = '__KEEP__' THEN last_inputs_hash ELSE excluded.last_inputs_hash END`

      const params = [
        revisionId,
        update.nodeId,
        contextHash,
        update.dependencyStatus || 'STALE',
        update.runtimeStatus,
        requiredTaskIdValue,
        lastInputsHashValue,
      ]

      console.log(`🔍 [DB_OPS] Executing SQL with params:`, params)

      ctx.db.run(query, params, function (err) {
        if (err) {
          console.error(
            `❌ [DB_OPS] SQL error for node ${update.nodeId}:`,
            err,
          )
          reject(
            new Error(`Failed to upsert node ${update.nodeId}: ${err.message}`),
          )
        }
        else {
          console.log(
            `✅ [DB_OPS] Successfully upserted node ${update.nodeId}`,
          )
          resolve()
        }
      })
    })
  }

  // Get revision timestamp for response
  const revisionTimestamp = await new Promise<number>((resolve, reject) => {
    ctx.db.get<{ timestamp_created: number }>(
      'SELECT timestamp_created FROM Versions WHERE version_id = ?',
      [revisionId],
      (err, row) => {
        if (err || !row)
          reject(
            new Error(
              'Failed to fetch revision timestamp for updateNodeStates.',
            ),
          )
        else resolve(row.timestamp_created)
      },
    )
  })

  return {
    id: revisionId,
    status: 'PROCESSING_UPDATES',
    createdAt: revisionTimestamp,
    nodes: [],
  }
}

/**
 * Internal implementation of refreshing a task
 */
export async function executeRefreshTaskInternal(
  ctx: InternalOperationContext,
  taskId: TraceId,
  options?: { clearVersion?: boolean },
): Promise<{
  taskId: TraceId
  runtimeStatus: string
  claimTimestamp: number | null
  claimWorkerId: string | null
  claimTtlSeconds: number | null
}> {
  // 1. Check if task exists first
  const currentState = await InternalDatabaseOperations.getTaskExecutionState(
    ctx.db,
    taskId,
  )
  if (!currentState) {
    throw new Error(`Task ${taskId} not found in TaskExecutionStates`)
  }

  // 2. Atomically update the task state only if it's in SUCCEEDED or FAILED state
  // This prevents race conditions by checking the status in the WHERE clause
  const { changedRows }
    = await InternalDatabaseOperations.updateTaskExecutionStateWithStatusCheck(
      ctx,
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
    const latestState = await InternalDatabaseOperations.getTaskExecutionState(
      ctx.db,
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
    await new Promise<void>((resolve, reject) => {
      ctx.db.run(
        `UPDATE Tasks SET current_version_id = NULL WHERE task_id = ?`,
        [taskId],
        (err) => {
          if (err)
            return reject(
              new Error(`Failed to clear task version: ${err.message}`),
            )
          resolve()
        },
      )
    })
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
  static async findRunnableTasks(
    actionId?: string,
    limit: number = 50,
  ): Promise<
    Array<{ taskId: TraceId, runtimeStatus: string, actionId: string }>
  > {
    const db = getDB()

    return new Promise((resolve, reject) => {
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

      db.all(query, params, (err, rows: any[]) => {
        if (err)
          reject(new Error(`Failed to find runnable tasks: ${err.message}`))
        else
          resolve(
            rows.map(row => ({
              taskId: row.task_id,
              runtimeStatus: row.runtime_status,
              actionId: row.action_id,
            })),
          )
      })
    })
  }

  static async getTaskWithCurrentVersion(taskId: TraceId): Promise<any> {
    const db = getDB()
    return InternalDatabaseOperations.getTask(db, taskId)
  }

  /**
   * Get workflow task and current revision from execution handle
   * Common pattern used by v14 revision forking mutations
   *
   * @returns { wiTaskId: TraceId, currentRevisionId: TraceId }
   */
  static async getWorkflowTaskFromHandle(handleId: TraceId): Promise<{
    wiTaskId: TraceId
    currentRevisionId: TraceId
  }> {
    const db = getDB()

    return new Promise((resolve, reject) => {
      // Step 1: Get WI Task from Handle
      db.get(
        `SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`,
        [handleId],
        (err, handleRow: any) => {
          if (err)
            return reject(new Error(`Failed to fetch handle: ${err.message}`))
          if (!handleRow)
            return reject(new Error(`Handle ${handleId} not found`))

          const wiTaskId = handleRow.task_id

          // Step 2: Get active REVISION version (O(1) lookup via active_revision_id)
          db.get(
            `SELECT active_revision_id FROM Tasks WHERE task_id = ?`,
            [wiTaskId],
            (err2, taskRow: any) => {
              if (err2)
                return reject(
                  new Error(`Failed to fetch active revision: ${err2.message}`),
                )
              if (!taskRow?.active_revision_id)
                return reject(
                  new Error(`WI Task ${wiTaskId} has no active revision`),
                )

              resolve({
                wiTaskId,
                currentRevisionId: taskRow.active_revision_id,
              })
            },
          )
        },
      )
    })
  }
}
