// Copyright (c) 2026 Wuji Labs Inc
import {
  SYSTEM_ACTIONS,
  actionIdToDbFormat,
  default_scope_id,
  isSystemAction,
  toAssetId,
  type ActionId,
  type DictLazyAsset,
  type LazyAsset,
} from 'playtiss'
import { store } from 'playtiss/asset-store'
import { jsonify, parseAssetText, type DictJSONAsset } from 'playtiss/types/json'
import {
  TraceIdGenerator,
  parseTraceId,
  type TraceId,
} from 'playtiss/types/trace_id'
import sqlite3 from 'sqlite3' // Import sqlite3 for Database type hint in helper
import type {
  Action,
  AuthPayload,
  NodeStateUpdateInput,
  Scalars,
  Task,
  TaskExecutionState,
  Version,
  VersionType,
  WorkflowRevision,
} from '../__generated__/graphql.js'
import { VersionType as VersionTypeEnum } from '../__generated__/graphql.js'
import { getDB } from '../db.js'
import {
  DatabaseQueries,
  ExternalDatabaseMutations,
  InternalDatabaseOperations,
  executeRefreshTaskInternal,
} from '../db/database-operations.js'
import { serializeMutation } from '../db/mutation-serializer.js'
import { SqliteEventProducer } from '../event-bus/sqlite-producer.js'
import { getDefaultContextAssetId } from '../utils/context.js'

// Representing AssetId as string, as per scalar definition
type AssetId = Scalars['AssetId']['input']

// Interface for database Task row
interface TaskRow {
  task_id: string
  current_version_id: string | null
  action_id: string
  scope_id: string
  inputs_content_hash: string
  name: string
  description?: string | null
  timestamp_created: number
}

// Global operation context for maintaining TraceId generator across related operations
let currentTraceIdGenerator: TraceIdGenerator | null = null

/**
 * Retry helper for SQLITE_BUSY errors with exponential backoff
 */
async function retryOnSqliteBusy<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 100,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    }
    catch (error: any) {
      const isSqliteBusy
        = error.code === 'SQLITE_BUSY'
          || error.message?.includes('SQLITE_BUSY')
          || error.message?.includes('database is locked')

      if (!isSqliteBusy || attempt === maxRetries) {
        throw error
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100
      console.log(
        `SQLITE_BUSY retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${error.message}`,
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Max retries exceeded') // Should never reach here
}

/**
 * Helper function to safely execute a transaction with nested transaction detection
 */
function executeInTransaction<T>(
  db: sqlite3.Database,
  operation: (startedTransaction: boolean) => void,
  debugName: string = 'transaction',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    db.serialize(() => {
      let startedTransaction = true
      db.run('BEGIN TRANSACTION;', (beginErr) => {
        if (beginErr) {
          if (
            beginErr.message.includes(
              'cannot start a transaction within a transaction',
            )
          ) {
            console.log(`${debugName}: Using existing transaction`)
            startedTransaction = false
          }
          else {
            return reject(beginErr)
          }
        }

        try {
          operation(startedTransaction)
        }
        catch (error) {
          if (startedTransaction) {
            db.run('ROLLBACK;', () => reject(error))
          }
          else {
            reject(error)
          }
        }
      })
    })
  })
}

/**
 * Gets or creates a TraceId generator for the current operation context.
 * This ensures all TraceIds generated within the same logical operation
 * share the same operation ID and timestamp.
 *
 * @param keepContext If true, preserves the existing context. If false (default),
 *                    resets the context to create a new operation.
 */
function getOperationTraceIdGenerator(
  keepContext: boolean = false,
): TraceIdGenerator {
  if (!keepContext) {
    currentTraceIdGenerator = null
  }

  if (!currentTraceIdGenerator) {
    currentTraceIdGenerator = new TraceIdGenerator()
  }
  return currentTraceIdGenerator
}

/**
 * Extracts timestamp from a TraceId to maintain consistency.
 */
function getTimestampFromTraceId(traceId: TraceId): number {
  const parsed = parseTraceId(traceId)
  return parsed.timestamp
}

/**
 * Helper function to create a Task and its corresponding TaskExecutionStates in a transaction.
 * This ensures atomic creation of both records for command tasks and computational tasks.
 */
function createTaskWithExecutionState(
  db: sqlite3.Database,
  taskId: TraceId,
  actionId: ActionId,
  inputsContentHash: AssetId,
  name: string,
  description: string,
  timestamp: number,
  scopeId: string = default_scope_id,
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let startedTransaction = true
      db.run('BEGIN TRANSACTION;', (beginErr) => {
        if (beginErr) {
          // Check if error is due to nested transaction
          if (
            beginErr.message.includes(
              'cannot start a transaction within a transaction',
            )
          ) {
            console.log(
              'createTaskWithExecutionState: Using existing transaction',
            )
            startedTransaction = false
          }
          else {
            return reject(beginErr)
          }
        }

        // Use the transaction-aware helper function for the actual work
        createTaskWithExecutionStateInTransaction(
          db,
          taskId,
          actionId,
          inputsContentHash,
          name,
          description,
          timestamp,
          scopeId,
        )
          .then(() => {
            if (startedTransaction) {
              db.run('COMMIT;', (commitErr) => {
                if (commitErr) return reject(commitErr)
                resolve()
              })
            }
            else {
              resolve()
            }
          })
          .catch((err) => {
            if (startedTransaction) db.run('ROLLBACK;')
            reject(err)
          })
      }) // Close db.run("BEGIN TRANSACTION;") callback
    })
  })
}

/**
 * Find an existing task with the same action and inputs
 * Returns the task_id if found, null otherwise
 */
async function findExistingTask(
  db: sqlite3.Database,
  actionId: ActionId,
  inputsContentHash: AssetId,
  scopeId: string = default_scope_id,
): Promise<TraceId | null> {
  return new Promise((resolve, reject) => {
    db.get<{ task_id: string }>(
      `SELECT task_id FROM Tasks
       WHERE scope_id = ? AND action_id = ? AND inputs_content_hash = ?
       LIMIT 1`,
      [scopeId, actionIdToDbFormat(actionId), inputsContentHash],
      (err, row) => {
        if (err) return reject(err)
        resolve(row ? (row.task_id as TraceId) : null)
      },
    )
  })
}

/**
 * Helper function to create a Task and its corresponding TaskExecutionState
 * within an existing transaction. Does not manage its own transaction.
 *
 * If a task with the same (scope_id, action_id, inputs_content_hash) already exists,
 * it returns successfully (idempotent operation).
 */
function createTaskWithExecutionStateInTransaction(
  db: sqlite3.Database,
  taskId: TraceId,
  actionId: ActionId,
  inputsContentHash: AssetId,
  name: string,
  description: string,
  timestamp: number,
  scopeId: string = default_scope_id,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create the Task
    db.run(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        scopeId,
        actionIdToDbFormat(actionId),
        inputsContentHash,
        name,
        description,
        timestamp,
      ],
      function (taskErr) {
        if (taskErr) {
          // Check if this is a UNIQUE constraint violation
          if (
            taskErr.message.includes(
              'UNIQUE constraint failed: Tasks.scope_id, Tasks.action_id, Tasks.inputs_content_hash',
            )
          ) {
            console.log(
              `ℹ️  Task with same inputs already exists: action=${actionId}, inputs=${inputsContentHash}`,
            )
            // Task already exists - this is OK, just return successfully
            return resolve()
          }
          return reject(new Error(`Failed to create task: ${taskErr.message}`))
        }

        // Create the TaskExecutionStates record
        db.run(
          `INSERT INTO TaskExecutionStates (task_id, runtime_status, action_id)
           VALUES (?, 'PENDING', ?)`,
          [taskId, actionIdToDbFormat(actionId)],
          function (scheduleErr) {
            if (scheduleErr) {
              return reject(
                new Error(`Failed to schedule task: ${scheduleErr.message}`),
              )
            }
            resolve()
          },
        )
      },
    )
  })
}

export const login = async (
  _parent: unknown,
  args: { username: string, password: string },
): Promise<AuthPayload> => {
  console.log(`Login attempt for user: ${args.username}`)
  // Mock implementation for Phase 1
  return {
    token: 'mock-token',
  }
}

/**
 * Helper to convert database task row to GraphQL Task type
 */
function convertDbTaskToGraphQL(dbTask: any, uniquenessHash: AssetId): Task {
  const currentVersion = dbTask.version_id
    ? {
        id: dbTask.version_id,
        taskId: dbTask.task_id,
        type: dbTask.version_type_tag,
        asset_content_hash: dbTask.asset_content_hash,
        timestamp_created: dbTask.version_timestamp,
        commit_message: dbTask.commit_message,
      }
    : null

  return {
    id: dbTask.task_id,
    actionId: dbTask.action_id,
    inputsContentHash: uniquenessHash,
    name: dbTask.name,
    description: dbTask.description,
    createdAt: dbTask.timestamp_created,
    currentVersion,
  }
}

export const createComputationalTask = async (
  _parent: unknown,
  args: { actionId: ActionId, uniquenessHash: AssetId },
): Promise<Task> => {
  const { actionId, uniquenessHash } = args
  const generator = getOperationTraceIdGenerator()

  try {
    // First, check if task already exists (idempotent behavior)
    const db = getDB()
    const existingTask = await InternalDatabaseOperations.fetchTaskByUniqueness(
      db,
      actionId,
      uniquenessHash,
    )

    if (existingTask) {
      // Task already exists, return it
      return convertDbTaskToGraphQL(existingTask, uniquenessHash)
    }

    // Task doesn't exist, create a new one using serialized mutation
    const taskId = generator.generate()
    const timestamp = getTimestampFromTraceId(taskId)

    const result = await ExternalDatabaseMutations.createComputationalTask(
      actionId,
      uniquenessHash,
      taskId,
      timestamp,
    )

    return {
      id: result.id,
      actionId: result.actionId as ActionId,
      inputsContentHash: result.inputsContentHash as AssetId,
      name: `Computational task for ${actionId}`,
      description: '',
      currentVersion: null,
      createdAt: timestamp,
    }
  }
  catch (error: any) {
    // Handle UNIQUE constraint race condition gracefully
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      // Another concurrent request created this task - fetch and return it
      const db = getDB()
      const existingTask
        = await InternalDatabaseOperations.fetchTaskByUniqueness(
          db,
          actionId,
          uniquenessHash,
        )

      if (existingTask) {
        return convertDbTaskToGraphQL(existingTask, uniquenessHash)
      }
    }

    console.error('Error in createComputationalTask:', error)
    throw new Error(`Failed to create computational task: ${error.message}`)
  }
}

export const createVersion = async (
  _parent: unknown,
  args: {
    taskId: TraceId
    versionType: VersionType | `${VersionType}`
    asset_content_hash?: AssetId | null
    commit_message?: string | null
  },
): Promise<Version> => {
  return retryOnSqliteBusy(async () => {
    const { taskId, versionType, asset_content_hash, commit_message } = args
    const db = getDB()
    const generator = getOperationTraceIdGenerator() // Defaults to resetting context
    const newDbVersionId = generator.generate()
    const timestamp = getTimestampFromTraceId(newDbVersionId)

    let versionTypeTag: string
    if (typeof versionType === 'string') {
      versionTypeTag = versionType
    }
    else {
      versionTypeTag = versionType as string
    }

    return new Promise<Version>((resolve, reject) => {
      db.run(
        `INSERT INTO Versions (
         version_id, task_id, version_type_tag, asset_content_hash,
         parent_version_id, timestamp_created, user_given_tag, commit_message,
         executed_def_version_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newDbVersionId,
          taskId,
          versionTypeTag,
          asset_content_hash,
          null,
          timestamp,
          null,
          commit_message,
          null,
        ],
        function (err) {
          if (err) {
            console.error('Error creating version:', err)
            return reject(err)
          }
          db.get(
            `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id,
                  timestamp_created, user_given_tag, commit_message, executed_def_version_id
           FROM Versions WHERE version_id = ?`,
            [newDbVersionId],
            (fetchErr, row: any) => {
              if (fetchErr) {
                console.error('Error fetching created version:', fetchErr)
                return reject(fetchErr)
              }
              if (row) {
                resolve({
                  id: row.version_id,
                  taskId: row.task_id,
                  type: row.version_type_tag as VersionType,
                  asset_content_hash: row.asset_content_hash,
                  parent_version_id: row.parent_version_id,
                  executed_def_version_id: row.executed_def_version_id,
                  timestamp_created: row.timestamp_created,
                  user_given_tag: row.user_given_tag,
                  commit_message: row.commit_message,
                })
              }
              else {
                reject(new Error('Failed to fetch version after creation.'))
              }
            },
          )
        },
      )
    })
  })
}

// Legacy orchestration logic has been moved to _legacy/orchestration.ts
// This logic should be implemented in the pipeline-runner (Workflow Engine)

// v12 Handle-Based API: Request execution and return a stable Handle ID
export const requestExecution = async (
  _parent: unknown,
  args: { actionId: ActionId, input: DictLazyAsset },
): Promise<TraceId> => {
  // Returns Handle ID
  const { actionId, input } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator() // Defaults to resetting context

  // Generate Handle ID (always new)
  const handleId = generator.generate()
  const timestamp = getTimestampFromTraceId(handleId)

  // Store the input object to get its AssetId
  const inputAssetId = toAssetId(await store(input))

  // Check if a task with the same inputs already exists
  const existingTaskId = await findExistingTask(db, actionId, inputAssetId)
  const workflowInstanceTaskId = existingTaskId || generator.generate()

  return new Promise<TraceId>((resolve, reject) => {
    // Check if this is a system action or user-defined action
    if (isSystemAction(actionId)) {
      // System actions can be executed directly as single-node workflows
      db.serialize(() => {
        let startedTransaction = true
        db.run('BEGIN TRANSACTION;', (beginErr) => {
          if (beginErr) {
            if (
              beginErr.message.includes(
                'cannot start a transaction within a transaction',
              )
            ) {
              console.log(
                'requestExecution: Using existing transaction for system action',
              )
              startedTransaction = false
            }
            else {
              return reject(beginErr)
            }
          }

          // Create ExecutionHandle mapping
          db.run(
            `INSERT INTO ExecutionHandles (handle_id, task_id, created_at, created_by, description)
           VALUES (?, ?, ?, ?, ?)`,
            [
              handleId,
              workflowInstanceTaskId,
              timestamp,
              'system',
              `Execution of ${actionId}`,
            ],
            function (handleErr) {
              if (handleErr) {
                if (startedTransaction) db.run('ROLLBACK;')
                return reject(
                  new Error(
                    `Failed to create execution handle: ${handleErr.message}`,
                  ),
                )
              }

              // If task already exists, skip creation and just commit
              if (existingTaskId) {
                console.log(
                  `ℹ️  Reusing existing task: ${existingTaskId} for action=${actionId}`,
                )
                if (startedTransaction) {
                  db.run('COMMIT;', (commitErr) => {
                    if (commitErr) return reject(commitErr)
                    resolve(handleId)
                  })
                }
                else {
                  resolve(handleId)
                }
                return
              }

              // Create WI Task using helper function (only if new)
              createTaskWithExecutionStateInTransaction(
                db,
                workflowInstanceTaskId,
                actionId,
                inputAssetId,
                `Execution of ${actionId}`,
                `Execution of system action ${actionId}`,
                timestamp,
              )
                .then(() => {
                  if (startedTransaction) {
                    db.run('COMMIT;', (commitErr) => {
                      if (commitErr) return reject(commitErr)
                      resolve(handleId)
                    })
                  }
                  else {
                    resolve(handleId)
                  }
                })
                .catch((taskErr) => {
                  if (startedTransaction) db.run('ROLLBACK;')
                  reject(taskErr)
                })
            },
          )
        }) // Close db.run("BEGIN TRANSACTION;") callback
      })
    }
    else {
      // For user-defined actions, check if it has a workflow definition
      db.get<TaskRow>(
        `SELECT current_version_id FROM Tasks WHERE task_id = ?`,
        [actionId],
        (err, actionDefTaskRow) => {
          if (err)
            return reject(
              new Error(
                `Failed to fetch action definition task ${actionId}: ${err.message}`,
              ),
            )

          // Allow execution even if current_version_id is empty (normal compute actions)
          const isWorkflowAction
            = actionDefTaskRow && actionDefTaskRow.current_version_id

          db.serialize(() => {
            let startedTransaction = true
            db.run('BEGIN TRANSACTION;', (beginErr) => {
              if (beginErr) {
                if (
                  beginErr.message.includes(
                    'cannot start a transaction within a transaction',
                  )
                ) {
                  console.log(
                    'requestExecution: Using existing transaction for user action',
                  )
                  startedTransaction = false
                }
                else {
                  return reject(beginErr)
                }
              }

              // Create ExecutionHandle mapping
              db.run(
                `INSERT INTO ExecutionHandles (handle_id, task_id, created_at, created_by, description)
               VALUES (?, ?, ?, ?, ?)`,
                [
                  handleId,
                  workflowInstanceTaskId,
                  timestamp,
                  'system',
                  `Execution of ${actionId}`,
                ],
                function (handleErr) {
                  if (handleErr) {
                    if (startedTransaction) db.run('ROLLBACK;')
                    return reject(
                      new Error(
                        `Failed to create execution handle: ${handleErr.message}`,
                      ),
                    )
                  }

                  // If task already exists, skip creation and just commit
                  if (existingTaskId) {
                    console.log(
                      `ℹ️  Reusing existing task: ${existingTaskId} for action=${actionId}`,
                    )
                    if (startedTransaction) {
                      db.run('COMMIT;', (commitErr) => {
                        if (commitErr) return reject(commitErr)
                        resolve(handleId)
                      })
                    }
                    else {
                      resolve(handleId)
                    }
                    return
                  }

                  // Create WI Task using helper function (only if new)
                  createTaskWithExecutionStateInTransaction(
                    db,
                    workflowInstanceTaskId,
                    actionId,
                    inputAssetId,
                    `Execution of ${actionId}`,
                    isWorkflowAction
                      ? `Workflow execution of ${actionId}`
                      : `Compute execution of ${actionId}`,
                    timestamp,
                  )
                    .then(() => {
                      if (startedTransaction) {
                        db.run('COMMIT;', (commitErr) => {
                          if (commitErr) return reject(commitErr)
                          resolve(handleId)
                        })
                      }
                      else {
                        resolve(handleId)
                      }
                    })
                    .catch((taskErr) => {
                      if (startedTransaction) db.run('ROLLBACK;')
                      reject(taskErr)
                    })
                },
              )
            }) // Close db.run("BEGIN TRANSACTION;") callback
          })
        },
      )
    }
  })
}

// Legacy mutation - to be removed after migration
export const requestWorkflowRevision = async (
  _parent: unknown,
  args: { actionId: TraceId, input: DictLazyAsset },
): Promise<WorkflowRevision> => {
  // Return non-nullable
  const { actionId, input } = args // input is a JS object from DictJSONAssetScalar
  const db = getDB()
  const generator = getOperationTraceIdGenerator() // Defaults to resetting context

  // Store the input object to get its CompoundAssetId
  const inputAssetId = toAssetId(await store(input)) // This is the new part

  const workflowInstanceTaskId = generator.generate()
  const newRevisionId = generator.generate() // Share same operation context
  const timestamp = getTimestampFromTraceId(newRevisionId)

  return new Promise<WorkflowRevision>((resolve, reject) => {
    // Corrected internal Promise type
    db.get<TaskRow>(
      `SELECT current_version_id FROM Tasks WHERE task_id = ?`,
      [actionId], // This is the ID of the Task that IS the workflow definition
      (err, actionDefTaskRow) => {
        if (err)
          return reject(
            new Error(
              `Failed to fetch action definition task ${actionId}: ${err.message}`,
            ),
          )
        if (!actionDefTaskRow || !actionDefTaskRow.current_version_id) {
          return reject(
            new Error(
              `Action definition task ${actionId} not found or has no current_version_id.`,
            ),
          )
        }
        const executedDefVersionId
          = actionDefTaskRow.current_version_id as TraceId

        db.serialize(() => {
          let startedTransaction = true
          db.run('BEGIN TRANSACTION;', (beginErr) => {
            if (beginErr) {
              if (
                beginErr.message.includes(
                  'cannot start a transaction within a transaction',
                )
              ) {
                console.log(
                  'requestWorkflowRevision: Using existing transaction',
                )
                startedTransaction = false
              }
              else {
                return reject(beginErr)
              }
            }

            db.run(
              `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, timestamp_created, current_version_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
              // Use inputAssetId for inputs_content_hash
              [
                workflowInstanceTaskId,
                default_scope_id,
                actionId,
                inputAssetId,
                `Execution of ${actionId}`,
                timestamp,
                newRevisionId,
              ],
              function (taskInsertErr) {
                if (taskInsertErr) {
                  if (startedTransaction) db.run('ROLLBACK;')
                  return reject(
                    new Error(
                      `Failed to create WI task: ${taskInsertErr.message}`,
                    ),
                  )
                }

                db.run(
                  `INSERT INTO Versions (version_id, task_id, version_type_tag, executed_def_version_id, timestamp_created, asset_content_hash, parent_version_id)
                 VALUES (?, ?, 'REVISION', ?, ?, ?, ?)`,
                  [
                    newRevisionId,
                    workflowInstanceTaskId,
                    executedDefVersionId,
                    timestamp,
                    null,
                    null,
                  ],
                  function (versionInsertErr) {
                    if (versionInsertErr) {
                      if (startedTransaction) db.run('ROLLBACK;')
                      return reject(
                        new Error(
                          `Failed to create revision version: ${versionInsertErr.message}`,
                        ),
                      )
                    }

                    // Note: Node initialization logic should be handled by the Workflow Engine
                    // For Phase 1, returning empty nodes array
                    if (startedTransaction) {
                      db.run('COMMIT;', (commitErr) => {
                        if (commitErr) return reject(commitErr)
                        resolve({
                          id: newRevisionId,
                          status: 'INITIALIZED',
                          createdAt: timestamp,
                          nodes: [], // Empty for now - should be populated by Engine
                        })
                      })
                    }
                    else {
                      resolve({
                        id: newRevisionId,
                        status: 'INITIALIZED',
                        createdAt: timestamp,
                        nodes: [], // Empty for now - should be populated by Engine
                      })
                    }
                  },
                )
              },
            )
          }) // Close db.run("BEGIN TRANSACTION;") callback
        })
      },
    )
  })
}

// v12 Handle-Based API: Request node rerun and return a Job ID
/**
 * v14: Request node rerun with revision forking
 *
 * Fork-first pattern:
 * 1. Get workflow task and current revision
 * 2. Fork revision to preserve history
 * 3. Find the required_task_id for the node
 * 4. Call refreshTask() to make it discoverable again
 * 5. NO core:xxx action, NO event bus (refreshTask makes it PENDING)
 */
export const requestNodeRerun = async (
  _parent: unknown,
  args: {
    handleId: TraceId
    nodeId: string
    contextAssetHash?: AssetId | null
    commitMessage?: string | null
    userTag?: string | null
  },
): Promise<TraceId> => {
  // Returns Job ID
  const { handleId, nodeId, contextAssetHash, commitMessage } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = await DatabaseQueries.getWorkflowTaskFromHandle(handleId)

    // 3. Duplicate workflow revision node states (non-transactional)
    const newRevisionId = generator.generate()
    const timestamp = getTimestampFromTraceId(newRevisionId)
    const ctx = { db, transactionId: 'requestNodeRerun' }

    await InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(ctx, {
      parentRevisionId: currentRevisionId,
      newRevisionId,
    })

    console.log(
      `✅ Duplicated node states: ${currentRevisionId} → ${newRevisionId}`,
    )

    // 4. Find the required_task_id for this node
    const defaultContext = await getDefaultContextAssetId()
    const contextHash = contextAssetHash || defaultContext

    const nodeStateRow: any = await new Promise((resolve, reject) => {
      db.get(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
        [newRevisionId, nodeId, contextHash],
        (err, row) => {
          if (err)
            return reject(
              new Error(`Failed to fetch node state: ${err.message}`),
            )
          if (!row)
            return reject(
              new Error(
                `Node ${nodeId} not found in workflow revision ${newRevisionId}`,
              ),
            )
          resolve(row)
        },
      )
    })

    const requiredTaskId = nodeStateRow.required_task_id
    if (!requiredTaskId) {
      throw new Error(`Node ${nodeId} has no required_task_id`)
    }

    // 5. Finalize revision fork + refresh task in single transaction
    await new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE;', (beginErr) => {
          if (beginErr) return reject(beginErr)

          // Part A: Finalize revision fork
          InternalDatabaseOperations.finalizeRevisionFork(ctx, {
            taskId: wiTaskId,
            parentRevisionId: currentRevisionId,
            newRevisionId,
            timestamp,
            triggerReason: commitMessage || `Rerun request for node ${nodeId}`,
          })
            .then(() => {
              // Part B: Refresh task to make it PENDING again and clear version for discoverability
              return executeRefreshTaskInternal(ctx, requiredTaskId, {
                clearVersion: true,
              })
            })
            .then(() => {
              // Part C: Update node state to RUNNING (waiting for worker)
              return InternalDatabaseOperations.updateNodeRuntimeStatus(ctx, {
                workflowRevisionId: newRevisionId,
                nodeId: nodeId,
                contextAssetHash: contextHash,
                runtimeStatus: 'RUNNING',
              })
            })
            .then(() => {
              // Commit transaction
              db.run('COMMIT;', (commitErr) => {
                if (commitErr) return reject(commitErr)
                resolve()
              })
            })
            .catch((error) => {
              db.run('ROLLBACK;', () => reject(error))
            })
        })
      })
    })

    console.log(
      `✅ Forked revision and refreshed task ${requiredTaskId} for node ${nodeId} rerun`,
    )

    return jobId
  }
  catch (error: any) {
    console.error(`Failed to request node rerun:`, error)
    throw new Error(`Failed to request node rerun: ${error.message}`)
  }
}

// v12 Handle-Based API: Request stale nodes update and return a Job ID
export const requestStaleNodesUpdate = async (
  _parent: unknown,
  args: { handleId: TraceId, nodeIds?: string[] | null },
): Promise<TraceId> => {
  const { handleId, nodeIds } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  console.log(`🔄 requestStaleNodesUpdate called for handle ${handleId}`)

  try {
    // Step 1-2: Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = await DatabaseQueries.getWorkflowTaskFromHandle(handleId)
    console.log(`📋 Found WI Task: ${wiTaskId}`)
    console.log(`📸 Current revision: ${currentRevisionId}`)

    // Step 3: Generate IDs
    const jobTaskId = generator.generate()
    const jobTimestamp = getTimestampFromTraceId(jobTaskId)
    const newRevisionId = generator.generate()
    const revisionTimestamp = getTimestampFromTraceId(newRevisionId)
    const outputVersionId = generator.generate()
    const outputTimestamp = getTimestampFromTraceId(outputVersionId)

    console.log(`📋 Job Task ID: ${jobTaskId}`)
    console.log(`📸 New Revision ID: ${newRevisionId}`)

    // Step 4: Store command parameters (inputs) and prepare output asset
    // Input includes CURRENT revision ID - this makes each update job unique
    const commandParams = {
      wiTaskId,
      currentRevisionId: currentRevisionId,
      staleNodeIds: nodeIds || null,
    }
    const commandAssetId = toAssetId(
      await store(commandParams as DictLazyAsset),
    )

    // Output includes NEW revision ID - the result of the update operation
    const outputAsset = {
      newRevisionId,
      wiTaskId,
      staleNodeIds: nodeIds || null,
      parentRevisionId: currentRevisionId,
    }
    const outputAssetId = toAssetId(await store(outputAsset as DictLazyAsset))

    // Step 5: Create Job Task (non-transactional)
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT INTO Tasks (
          task_id, scope_id, action_id, inputs_content_hash,
          name, description, timestamp_created
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          jobTaskId,
          default_scope_id,
          actionIdToDbFormat(SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE),
          commandAssetId,
          'Update stale nodes',
          `Update stale nodes in workflow ${wiTaskId}`,
          jobTimestamp,
        ],
        (err) => {
          if (err)
            return reject(
              new Error(`Failed to create job task: ${err.message}`),
            )
          resolve()
        },
      )
    })

    // Step 6: Duplicate workflow revision node states (non-transactional)
    const ctx = { db, transactionId: 'requestStaleNodesUpdate' }
    await InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(ctx, {
      parentRevisionId: currentRevisionId,
      newRevisionId,
    })

    console.log(
      `✅ Duplicated node states: ${currentRevisionId} → ${newRevisionId}`,
    )

    // Step 8-9-10-11: Atomic transaction for OUTPUT, job task update, revision finalization, and event
    await new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION;', (beginErr) => {
          if (beginErr) return reject(beginErr)

          // Step 8: Create OUTPUT version for Job Task
          db.run(
            `INSERT INTO Versions (
              version_id, task_id, version_type_tag, asset_content_hash,
              parent_version_id, timestamp_created, commit_message
            ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
            [
              outputVersionId,
              jobTaskId,
              'OUTPUT',
              outputAssetId,
              outputTimestamp,
              'Revision created',
            ],
            (err8) => {
              if (err8) {
                db.run('ROLLBACK;')
                return reject(
                  new Error(`Failed to create output version: ${err8.message}`),
                )
              }

              // Step 9: Update Job Task's current_version_id
              db.run(
                `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
                [outputVersionId, jobTaskId],
                (err9) => {
                  if (err9) {
                    db.run('ROLLBACK;')
                    return reject(
                      new Error(`Failed to update job task: ${err9.message}`),
                    )
                  }

                  // Step 10: Finalize revision fork (create Versions and update Tasks.current_version_id)
                  InternalDatabaseOperations.finalizeRevisionFork(ctx, {
                    taskId: wiTaskId,
                    parentRevisionId: currentRevisionId,
                    newRevisionId,
                    timestamp: revisionTimestamp,
                    triggerReason: 'Update stale nodes',
                  })
                    .then(() => {
                      // Step 11: Emit special event for stale update
                      const eventId = generator.generate()
                      const eventTimestamp = getTimestampFromTraceId(eventId)
                      const eventPayload = JSON.stringify({
                        task_id: jobTaskId,
                        version_id: outputVersionId,
                        new_revision_id: newRevisionId,
                        wi_task_id: wiTaskId,
                        stale_node_ids: nodeIds || null,
                      })

                      db.run(
                        `INSERT INTO EventLog (
                          event_id, topic, payload, timestamp_created
                        ) VALUES (?, ?, ?, ?)`,
                        [
                          eventId,
                          'stale_update_revision_created',
                          eventPayload,
                          eventTimestamp,
                        ],
                        (err11) => {
                          if (err11) {
                            db.run('ROLLBACK;')
                            return reject(
                              new Error(
                                `Failed to emit event: ${err11.message}`,
                              ),
                            )
                          }

                          // Commit transaction
                          db.run('COMMIT;', (err12) => {
                            if (err12)
                              return reject(
                                new Error(`Failed to commit: ${err12.message}`),
                              )

                            console.log(
                              `✅ Stale update job completed atomically`,
                            )
                            console.log(`📸 New revision: ${newRevisionId}`)
                            console.log(`📋 Job ID: ${jobTaskId}`)

                            resolve()
                          })
                        },
                      )
                    })
                    .catch((err10) => {
                      db.run('ROLLBACK;')
                      return reject(
                        new Error(
                          `Failed to finalize revision fork: ${err10.message}`,
                        ),
                      )
                    })
                },
              )
            },
          )
        })
      })
    })

    return jobTaskId
  }
  catch (error: any) {
    console.error(`Failed to request stale nodes update:`, error)
    throw new Error(`Failed to request stale nodes update: ${error.message}`)
  }
}

// v12 Handle-Based API: Submit player input and return a Job ID
/**
 * v14: Submit player input with revision forking
 *
 * Fork-first pattern:
 * 1. Get workflow task and current revision
 * 2. Fork revision to preserve history
 * 3. Emit task_player_submitted event to event bus
 * 4. Pipeline-runner will handle updating WorkflowRevisionNodeStates
 */
export const submitPlayerInput = async (
  _parent: unknown,
  args: {
    handleId: TraceId
    nodeId: string
    contextAssetHash?: AssetId | null
    outputAssetId: AssetId
    commitMessage?: string | null
  },
): Promise<TraceId> => {
  // Returns Job ID
  const { handleId, nodeId, contextAssetHash, outputAssetId, commitMessage }
    = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = await DatabaseQueries.getWorkflowTaskFromHandle(handleId)

    // 3. Fork revision to preserve history
    const newRevisionId = generator.generate()
    const timestamp = getTimestampFromTraceId(newRevisionId)

    await ExternalDatabaseMutations.forkRevision({
      taskId: wiTaskId,
      parentRevisionId: currentRevisionId,
      newRevisionId,
      timestamp,
      triggerReason: `Player input for node ${nodeId}`,
    })

    console.log(
      `🔀 Forked revision for submitPlayerInput: ${currentRevisionId} → ${newRevisionId}`,
    )

    // 4. Get node's task ID from WorkflowRevisionNodeStates
    const defaultContext = await getDefaultContextAssetId()
    const nodeState = await new Promise<any>((resolve, reject) => {
      db.get(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
        [newRevisionId, nodeId, contextAssetHash || defaultContext],
        (err, row) => {
          if (err) return reject(err)
          resolve(row)
        },
      )
    })

    if (!nodeState?.required_task_id) {
      throw new Error(`Node ${nodeId} has no task assigned`)
    }

    // 5. Update node state to IDLE (player provided result, task finished)
    const ctx = { db, transactionId: 'submitPlayerInput' }
    await InternalDatabaseOperations.updateNodeRuntimeStatus(ctx, {
      workflowRevisionId: newRevisionId,
      nodeId: nodeId,
      contextAssetHash: contextAssetHash || defaultContext,
      runtimeStatus: 'IDLE',
    })

    console.log(`✅ Updated node ${nodeId} to IDLE state after player input`)

    // 6. Emit task_player_submitted event to event bus
    const eventProducer = new SqliteEventProducer()

    await eventProducer.produce(
      'task_player_submitted',
      {
        task_id: nodeState.required_task_id, // Node's computational task ID
        workflow_task_id: wiTaskId, // Workflow instance task ID
        workflow_revision_id: newRevisionId,
        node_id: nodeId,
        context_asset_hash: contextAssetHash || defaultContext,
        output_asset_id: outputAssetId,
        commit_message: commitMessage || `Player input for node ${nodeId}`,
      },
      db,
    )

    console.log(`✅ Emitted task_player_submitted event for node ${nodeId}`)

    return jobId
  }
  catch (error: any) {
    console.error(`Failed to submit player input:`, error)
    throw new Error(`Failed to submit player input: ${error.message}`)
  }
}

/**
 * v14: Fail player task with revision forking
 *
 * Fork-first pattern:
 * 1. Get workflow task and current revision
 * 2. Fork revision to preserve history
 * 3. Emit task_player_failed event to event bus
 * 4. Pipeline-runner will handle updating WorkflowRevisionNodeStates
 */
export const failPlayerTask = async (
  _parent: unknown,
  args: {
    handleId: TraceId
    nodeId: string
    contextAssetHash?: AssetId | null
    reason: string
  },
): Promise<TraceId> => {
  // Returns Job ID
  const { handleId, nodeId, contextAssetHash, reason } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = await DatabaseQueries.getWorkflowTaskFromHandle(handleId)

    // 3. Fork revision to preserve history
    const newRevisionId = generator.generate()
    const timestamp = getTimestampFromTraceId(newRevisionId)

    await ExternalDatabaseMutations.forkRevision({
      taskId: wiTaskId,
      parentRevisionId: currentRevisionId,
      newRevisionId,
      timestamp,
      triggerReason: `Player task failed: ${reason}`,
    })

    console.log(
      `🔀 Forked revision for failPlayerTask: ${currentRevisionId} → ${newRevisionId}`,
    )

    // 4. Get node's task ID from WorkflowRevisionNodeStates
    const defaultContext = await getDefaultContextAssetId()
    const nodeState = await new Promise<any>((resolve, reject) => {
      db.get(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
        [newRevisionId, nodeId, contextAssetHash || defaultContext],
        (err, row) => {
          if (err) return reject(err)
          resolve(row)
        },
      )
    })

    if (!nodeState?.required_task_id) {
      throw new Error(`Node ${nodeId} has no task assigned`)
    }

    // 5. Update node state to FAILED (player marked task as failed)
    const ctx = { db, transactionId: 'failPlayerTask' }
    await InternalDatabaseOperations.updateNodeRuntimeStatus(ctx, {
      workflowRevisionId: newRevisionId,
      nodeId: nodeId,
      contextAssetHash: contextAssetHash || defaultContext,
      runtimeStatus: 'FAILED',
    })

    console.log(
      `✅ Updated node ${nodeId} to FAILED state after player failure`,
    )

    // 6. Emit task_player_failed event to event bus
    const eventProducer = new SqliteEventProducer()

    await eventProducer.produce(
      'task_player_failed',
      {
        task_id: nodeState.required_task_id, // Node's computational task ID
        workflow_task_id: wiTaskId, // Workflow instance task ID
        workflow_revision_id: newRevisionId,
        node_id: nodeId,
        context_asset_hash: contextAssetHash || defaultContext,
        reason: reason,
      },
      db,
    )

    console.log(`✅ Emitted task_player_failed event for node ${nodeId}`)

    return jobId
  }
  catch (error: any) {
    console.error(`Failed to fail player task:`, error)
    throw new Error(`Failed to fail player task: ${error.message}`)
  }
}

export const updateNodeStates = async (
  _parent: unknown,
  args: { revisionId: TraceId, nodeUpdates: NodeStateUpdateInput[] }, // Used the imported type
): Promise<WorkflowRevision> => {
  const { revisionId, nodeUpdates } = args
  const defaultContext = await getDefaultContextAssetId()

  console.log(
    `🔍 [RESOLVER] updateNodeStates called with revisionId=${revisionId}, ${nodeUpdates.length} updates`,
  )
  nodeUpdates.forEach((update, idx) => {
    console.log(
      `🔍 [RESOLVER] Update ${idx}: nodeId=${update.nodeId}, lastInputsHash=${update.lastInputsHash || 'undefined'}`,
    )
  })

  try {
    // Transform nodeUpdates to include context asset hash and filter valid statuses
    const transformedUpdates = nodeUpdates.map(update => ({
      nodeId: update.nodeId,
      dependencyStatus:
        update.dependencyStatus === 'FRESH'
        || update.dependencyStatus === 'STALE'
          ? update.dependencyStatus
          : undefined,
      runtimeStatus: [
        'IDLE',
        'RUNNING',
        'FAILED',
        'PENDING_PLAYER_INPUT',
      ].includes(update.runtimeStatus as string)
        ? (update.runtimeStatus as
        | 'IDLE'
        | 'RUNNING'
        | 'FAILED'
        | 'PENDING_PLAYER_INPUT')
        : undefined,
      contextAssetHash: update.contextAssetHash || defaultContext,
      requiredTaskId: (update as any).requiredTaskId as TraceId | undefined,
      lastInputsHash: update.lastInputsHash as AssetId | undefined,
    }))

    console.log(`🔍 [RESOLVER] Transformed updates:`)
    transformedUpdates.forEach((update, idx) => {
      console.log(
        `🔍 [RESOLVER] Transformed ${idx}: nodeId=${update.nodeId}, lastInputsHash=${update.lastInputsHash || 'undefined'}`,
      )
    })

    const result = await ExternalDatabaseMutations.updateNodeStates(
      revisionId,
      transformedUpdates,
    )
    return result
  }
  catch (error: any) {
    console.error(
      `Failed to update node states for revision ${revisionId}:`,
      error,
    )
    throw new Error(`Failed to update node states: ${error.message}`)
  }
}

// This function is obsolete and replaced by the v10 API (claimTask, etc.)

// --- APIs for Action and Workflow Definition Building ---

export const createAction = async (
  _parent: unknown,
  args: { name: string, description: string },
): Promise<Action> => {
  const { name, description } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator() // Defaults to resetting context

  const actionTaskId = generator.generate()
  const timestamp = getTimestampFromTraceId(actionTaskId)

  return new Promise<Action>((resolve, reject) => {
    // Create an Action Definition Task with action_id = core:define_action system action TraceId
    db.run(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actionTaskId,
        default_scope_id,
        actionIdToDbFormat(SYSTEM_ACTIONS.CORE_DEFINE_ACTION),
        null,
        name,
        description,
        timestamp,
      ],
      function (err) {
        if (err) {
          return reject(
            new Error(`Failed to create action definition task: ${err.message}`),
          )
        }

        // Return an Action object (without actionId field)
        resolve({
          id: actionTaskId as ActionId,
          name,
          description,
          currentVersion: null,
          createdAt: timestamp,
        })
      },
    )
  })
}

export const createWorkflowDefinitionVersion = async (
  _parent: unknown,
  args: {
    actionId: TraceId
    workflowDefinition: DictLazyAsset
    commitMessage?: string | null
  },
): Promise<Version> => {
  const { actionId, workflowDefinition, commitMessage } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  // Store the workflow definition object to get its AssetId
  const workflowAssetId = toAssetId(await store(workflowDefinition))

  const versionId = generator.generate()
  const timestamp = getTimestampFromTraceId(versionId)

  return new Promise<Version>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION;', (beginErr) => {
        if (beginErr) return reject(beginErr)
      })

      // Create the workflow definition version
      db.run(
        `INSERT INTO Versions (version_id, task_id, version_type_tag, asset_content_hash, timestamp_created, commit_message)
         VALUES (?, ?, 'WORKFLOW_DEFINITION', ?, ?, ?)`,
        [
          versionId,
          actionId,
          workflowAssetId,
          timestamp,
          commitMessage || 'Workflow definition created',
        ],
        function (versionErr) {
          if (versionErr) {
            db.run('ROLLBACK;')
            return reject(
              new Error(
                `Failed to create workflow definition version: ${versionErr.message}`,
              ),
            )
          }

          // Update the Task's current_version_id to point to this new version
          db.run(
            `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
            [versionId, actionId],
            function (updateErr) {
              if (updateErr) {
                db.run('ROLLBACK;')
                return reject(
                  new Error(
                    `Failed to update task current version: ${updateErr.message}`,
                  ),
                )
              }

              db.run('COMMIT;', (commitErr) => {
                if (commitErr) return reject(commitErr)

                resolve({
                  id: versionId,
                  taskId: actionId,
                  type: VersionTypeEnum.WorkflowDefinition,
                  asset_content_hash: workflowAssetId,
                  parent_version_id: null,
                  executed_def_version_id: null,
                  timestamp_created: timestamp,
                  user_given_tag: null,
                  commit_message:
                    commitMessage || 'Workflow definition created',
                })
              })
            },
          )
        },
      )
    })
  })
}

// --- v10 Worker API Mutations ---

export const scheduleTaskForExecution = async (
  _parent: unknown,
  args: { taskId: TraceId },
): Promise<TaskExecutionState> => {
  const { taskId } = args

  try {
    const result
      = await ExternalDatabaseMutations.scheduleTaskForExecution(taskId)
    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to schedule task for execution ${taskId}:`, error)
    throw new Error(`Failed to schedule task for execution: ${error.message}`)
  }
}

export const claimTask = async (
  _parent: unknown,
  args: { taskId: TraceId, workerId: string, ttl: number },
): Promise<TaskExecutionState | null> => {
  const { taskId, workerId, ttl } = args

  // Import the new database operations

  try {
    const result = await ExternalDatabaseMutations.claimTask(
      taskId,
      workerId,
      ttl,
    )

    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to claim task ${taskId}:`, error)
    throw new Error(`Failed to claim task: ${error.message}`)
  }
}

export const reportTaskSuccess = async (
  _parent: unknown,
  args: { taskId: TraceId, resultVersionId: TraceId, workerId: string },
): Promise<TaskExecutionState> => {
  const { taskId, resultVersionId, workerId } = args

  // Import the new database operations

  try {
    const result = await ExternalDatabaseMutations.reportTaskSuccess(
      taskId,
      resultVersionId,
      workerId,
    )

    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to report task success ${taskId}:`, error)
    throw new Error(`Failed to report task success: ${error.message}`)
  }
}

export const reportTaskFailure = async (
  _parent: unknown,
  args: { taskId: TraceId, errorVersionId: TraceId, workerId: string },
): Promise<TaskExecutionState> => {
  const { taskId, errorVersionId, workerId } = args

  try {
    const result = await ExternalDatabaseMutations.reportTaskFailure(
      taskId,
      errorVersionId,
      workerId,
    )
    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to report task failure ${taskId}:`, error)
    throw new Error(`Failed to report task failure: ${error.message}`)
  }
}

/**
 * Claim workflow task and generate revision version ID as workflowRevisionId
 * This combines task claiming with revision version generation for workflow orchestration
 */
export const claimWorkflowTask = async (
  _parent: unknown,
  args: { taskId: TraceId, workerId: string, ttl: number },
): Promise<TaskExecutionState | null> => {
  const { taskId, workerId, ttl } = args
  const generator = getOperationTraceIdGenerator() // Reset context for new operation

  // Import the new database operations

  try {
    // Generate revision version ID for workflow revision tracking
    const revisionVersionId = generator.generate()
    const timestamp = getTimestampFromTraceId(revisionVersionId)

    // Use the new external mutation (automatically serialized)
    const result = await ExternalDatabaseMutations.claimWorkflowTask(
      taskId,
      workerId,
      ttl,
      revisionVersionId,
      timestamp,
    )

    console.log(
      `✅ Claimed workflow task ${taskId} with revision version ${revisionVersionId}`,
    )

    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to claim workflow task ${taskId}:`, error)
    throw new Error(`Failed to claim workflow task: ${error.message}`)
  }
}

export const refreshTask = async (
  _parent: unknown,
  args: { taskId: TraceId },
): Promise<TaskExecutionState> => {
  const { taskId } = args

  try {
    const result = await ExternalDatabaseMutations.refreshTask(taskId)

    return {
      taskId: result.taskId,
      runtimeStatus: result.runtimeStatus as any,
      claim_timestamp: result.claimTimestamp,
      claim_worker_id: result.claimWorkerId,
      claim_ttl_seconds: result.claimTtlSeconds,
    }
  }
  catch (error: any) {
    console.error(`Failed to refresh task ${taskId}:`, error)
    throw new Error(`Failed to refresh task: ${error.message}`)
  }
}

/**
 * v14: Fork a workflow revision (Copy-on-Write)
 *
 * This is the core primitive for v14 revision forking mechanism.
 * Creates a new revision by copying all WorkflowRevisionNodeStates from the current revision,
 * preserving the old revision as immutable history ("Immutable Tail").
 *
 * Used by:
 * - Pipeline-runner when detecting redelivery (output hash changed)
 * - Mutations like submitPlayerInput, requestStaleNodesUpdate before state changes
 *
 * @returns New revision ID
 */
export const forkWorkflowRevision = async (
  _parent: unknown,
  args: {
    taskId: TraceId
    currentRevisionId: TraceId
    triggerReason?: string | null
  },
): Promise<TraceId> => {
  const { taskId, currentRevisionId, triggerReason } = args
  const generator = getOperationTraceIdGenerator()

  console.log(
    `🔀 Forking revision for workflow task ${taskId}: ${currentRevisionId} → new revision`,
  )
  if (triggerReason) {
    console.log(`   Reason: ${triggerReason}`)
  }

  // Generate new revision ID
  const newRevisionId = generator.generate()
  const timestamp = getTimestampFromTraceId(newRevisionId)

  // Call database operation (manages its own transaction)
  await ExternalDatabaseMutations.forkRevision({
    taskId,
    parentRevisionId: currentRevisionId,
    newRevisionId,
    timestamp,
    triggerReason: triggerReason || undefined,
  })

  console.log(`✅ Forked revision: ${currentRevisionId} → ${newRevisionId}`)

  // Emit revision_forked event (after transaction completes)
  const db = getDB()
  const eventProducer = new SqliteEventProducer()
  await eventProducer.produce(
    'revision_forked',
    {
      task_id: taskId,
      parent_revision_id: currentRevisionId,
      new_revision_id: newRevisionId,
      trigger_reason: triggerReason || 'Manual fork',
    },
    db,
  )

  return newRevisionId
}

// --- Merge Accumulator API Mutations (v14.1) ---

/**
 * Set/overwrite merge accumulator state atomically
 * Used when merge node receives all inputs and becomes ready
 */
export const setMergeAccumulator = async (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
    accumulatorData: DictLazyAsset
  },
): Promise<boolean> => {
  const {
    pipelineId,
    workflowRevisionId,
    contextAssetHash,
    nodeId,
    accumulatorData,
  } = args

  return serializeMutation('setMergeAccumulator', async () => {
    const db = getDB()

    return new Promise<boolean>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) return reject(err)

          const jsonData = jsonify(accumulatorData) as DictJSONAsset
          const insertedJsonString = JSON.stringify(jsonData)

          db.run(
            `INSERT OR REPLACE INTO PipelineMergeAccumulator
             (pipeline_id, workflow_revision_id, context_asset_hash, node_id, accumulator_json, updated_at)
             VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))`,
            [
              pipelineId,
              workflowRevisionId,
              contextAssetHash,
              nodeId,
              insertedJsonString,
            ],
            (err) => {
              if (err) {
                db.run('ROLLBACK')
                return reject(err)
              }

              db.run('COMMIT', (err) => {
                if (err) {
                  db.run('ROLLBACK')
                  return reject(err)
                }
                resolve(true)
              })
            },
          )
        })
      })
    })
  })
}

/**
 * Atomically merge update: read current state, update one key, write back
 * Returns the updated accumulator state
 * Used when merge node receives partial input
 */
export const mergeMergeAccumulator = async (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
    key: string
    value: LazyAsset
  },
): Promise<DictLazyAsset> => {
  const {
    pipelineId,
    workflowRevisionId,
    contextAssetHash,
    nodeId,
    key,
    value,
  } = args

  return serializeMutation('mergeMergeAccumulator', async () => {
    const db = getDB()

    return new Promise<DictLazyAsset>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) return reject(err)

          // Read current accumulator
          db.get(
            `SELECT accumulator_json FROM PipelineMergeAccumulator
             WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
            [pipelineId, workflowRevisionId, contextAssetHash, nodeId],
            (err, row: any) => {
              if (err) {
                db.run('ROLLBACK')
                return reject(err)
              }

              try {
                const current: DictJSONAsset = row?.accumulator_json
                  ? JSON.parse(row.accumulator_json)
                  : {}

                // Update with new key/value
                current[key] = jsonify(value)

                const mergedJsonString = JSON.stringify(current)

                // Upsert back to database
                db.run(
                  `INSERT OR REPLACE INTO PipelineMergeAccumulator
                   (pipeline_id, workflow_revision_id, context_asset_hash, node_id, accumulator_json, updated_at)
                   VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))`,
                  [
                    pipelineId,
                    workflowRevisionId,
                    contextAssetHash,
                    nodeId,
                    mergedJsonString,
                  ],
                  (err) => {
                    if (err) {
                      db.run('ROLLBACK')
                      return reject(err)
                    }

                    db.run('COMMIT', (err) => {
                      if (err) {
                        db.run('ROLLBACK')
                        return reject(err)
                      }
                      resolve(parseAssetText(mergedJsonString) as DictLazyAsset)
                    })
                  },
                )
              }
              catch (parseErr) {
                db.run('ROLLBACK')
                reject(parseErr)
              }
            },
          )
        })
      })
    })
  })
}

/**
 * Delete merge accumulator when task is scheduled
 */
export const deleteMergeAccumulator = async (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
  },
): Promise<boolean> => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId } = args

  return serializeMutation('deleteMergeAccumulator', async () => {
    const db = getDB()

    return new Promise<boolean>((resolve, reject) => {
      db.run(
        `DELETE FROM PipelineMergeAccumulator
         WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
        [pipelineId, workflowRevisionId, contextAssetHash, nodeId],
        (err) => {
          if (err) return reject(err)
          resolve(true)
        },
      )
    })
  })
}

/**
 * Save or update an interceptor session
 * Creates a new session if sessionId doesn't exist, updates if it does.
 */
export const saveInterceptorSession = async (
  _parent: unknown,
  args: {
    input: {
      sessionId: string
      sessionTaskId: TraceId
      computationTaskId: TraceId
      currentRevisionId: TraceId
      referenceContextJson?: string | null
      toolCallMappingJson?: string | null
    }
  },
): Promise<{
  sessionId: string
  sessionTaskId: Scalars['TraceId']['output']
  computationTaskId: Scalars['TraceId']['output']
  currentRevisionId: Scalars['TraceId']['output']
  referenceContextJson: string | null
  toolCallMappingJson: string | null
  createdAt: number
  lastActivity: number
}> => {
  const { input } = args
  const now = Date.now()

  return serializeMutation('saveInterceptorSession', async () => {
    const db = getDB()

    return new Promise((resolve, reject) => {
      // Use INSERT OR REPLACE to handle both insert and update
      db.run(
        `INSERT INTO InterceptorSessions
         (session_id, session_task_id, computation_task_id, current_revision_id,
          reference_context_json, tool_call_mapping_json, created_at, last_activity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           computation_task_id = excluded.computation_task_id,
           current_revision_id = excluded.current_revision_id,
           reference_context_json = excluded.reference_context_json,
           tool_call_mapping_json = excluded.tool_call_mapping_json,
           last_activity = excluded.last_activity`,
        [
          input.sessionId,
          input.sessionTaskId,
          input.computationTaskId,
          input.currentRevisionId,
          input.referenceContextJson || null,
          input.toolCallMappingJson || null,
          now, // created_at - only used on INSERT
          now, // last_activity - updated on both INSERT and UPDATE
        ],
        function (err) {
          if (err) {
            console.error('Error saving interceptor session:', err)
            return reject(err)
          }

          // Fetch the saved/updated row to return
          db.get<{
            session_id: string
            session_task_id: string
            computation_task_id: string
            current_revision_id: string
            reference_context_json: string | null
            tool_call_mapping_json: string | null
            created_at: number
            last_activity: number
          }>(
            `SELECT * FROM InterceptorSessions WHERE session_id = ?`,
            [input.sessionId],
            (err, row) => {
              if (err) {
                console.error('Error fetching saved interceptor session:', err)
                return reject(err)
              }

              if (!row) {
                return reject(new Error('Failed to save interceptor session'))
              }

              resolve({
                sessionId: row.session_id,
                sessionTaskId: row.session_task_id as Scalars['TraceId']['output'],
                computationTaskId: row.computation_task_id as Scalars['TraceId']['output'],
                currentRevisionId: row.current_revision_id as Scalars['TraceId']['output'],
                referenceContextJson: row.reference_context_json,
                toolCallMappingJson: row.tool_call_mapping_json,
                createdAt: row.created_at,
                lastActivity: row.last_activity,
              })
            },
          )
        },
      )
    })
  })
}
