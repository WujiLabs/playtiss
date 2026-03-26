// Copyright (c) 2026 Wuji Labs Inc
import type { Database } from 'better-sqlite3'
import {
  type ActionId,
  actionIdToDbFormat,
  type AssetValue,
  default_scope_id,
  type DictAsset,
  isSystemAction,
  SYSTEM_ACTIONS,
} from 'playtiss'
import { store } from 'playtiss/asset-store'
import { decodeFromString, encodeToString } from 'playtiss/types/json'
import {
  parseTraceId,
  type TraceId,
  TraceIdGenerator,
} from 'playtiss/types/trace_id'

import type {
  Action,
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
  executeRefreshTaskInternal,
  ExternalDatabaseMutations,
  InternalDatabaseOperations,
} from '../db/database-operations.js'
import {
  serializeMutation,
  withTransaction,
} from '../db/mutation-serializer.js'
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
 * Find an existing task with the same action and inputs
 * Returns the task_id if found, null otherwise
 */
function findExistingTask(
  db: Database,
  actionId: ActionId,
  inputsContentHash: AssetId,
  scopeId: string = default_scope_id,
): TraceId | null {
  const row = db.prepare(
    `SELECT task_id FROM Tasks
     WHERE scope_id = ? AND action_id = ? AND inputs_content_hash = ?
     LIMIT 1`,
  ).get(scopeId, actionIdToDbFormat(actionId), inputsContentHash) as { task_id: string } | undefined
  return row ? (row.task_id as TraceId) : null
}

/**
 * Helper function to create a Task and its corresponding TaskExecutionState
 * within an existing transaction. Does not manage its own transaction.
 *
 * If a task with the same (scope_id, action_id, inputs_content_hash) already exists,
 * it returns successfully (idempotent operation).
 */
function createTaskWithExecutionStateInTransaction(
  db: Database,
  taskId: TraceId,
  actionId: ActionId,
  inputsContentHash: AssetId,
  name: string,
  description: string,
  timestamp: number,
  scopeId: string = default_scope_id,
): void {
  try {
    // Create the Task
    db.prepare(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      scopeId,
      actionIdToDbFormat(actionId),
      inputsContentHash,
      name,
      description,
      timestamp,
    )
  }
  catch (err: any) {
    // Check if this is a UNIQUE constraint violation
    if (
      err.message?.includes(
        'UNIQUE constraint failed: Tasks.scope_id, Tasks.action_id, Tasks.inputs_content_hash',
      )
    ) {
      console.log(
        `ℹ️  Task with same inputs already exists: action=${actionId}, inputs=${inputsContentHash}`,
      )
      // Task already exists - this is OK, just return successfully
      return
    }
    throw new Error(`Failed to create task: ${err.message}`)
  }

  // Create the TaskExecutionStates record
  db.prepare(
    `INSERT INTO TaskExecutionStates (task_id, runtime_status, action_id)
     VALUES (?, 'PENDING', ?)`,
  ).run(taskId, actionIdToDbFormat(actionId))
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

export const createComputationalTask = (
  _parent: unknown,
  args: { actionId: ActionId, uniquenessHash: AssetId },
): Task => {
  const { actionId, uniquenessHash } = args
  const generator = getOperationTraceIdGenerator()

  try {
    // First, check if task already exists (idempotent behavior)
    const db = getDB()
    const existingTask = InternalDatabaseOperations.fetchTaskByUniqueness(
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

    const result = ExternalDatabaseMutations.createComputationalTask(
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
        = InternalDatabaseOperations.fetchTaskByUniqueness(
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

export const createVersion = (
  _parent: unknown,
  args: {
    taskId: TraceId
    versionType: VersionType | `${VersionType}`
    asset_content_hash?: AssetId | null
    commit_message?: string | null
  },
): Version => {
  const { taskId, versionType, asset_content_hash, commit_message } = args
  const generator = getOperationTraceIdGenerator()
  const newDbVersionId = generator.generate()
  const timestamp = getTimestampFromTraceId(newDbVersionId)

  const versionTypeTag: string = typeof versionType === 'string'
    ? versionType
    : versionType as string

  return withTransaction('createVersion', (db) => {
    db.prepare(
      `INSERT INTO Versions (
       version_id, task_id, version_type_tag, asset_content_hash,
       parent_version_id, timestamp_created, user_given_tag, commit_message,
       executed_def_version_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newDbVersionId, taskId, versionTypeTag, asset_content_hash,
      null, timestamp, null, commit_message, null)

    const row = db.prepare(
      `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id,
              timestamp_created, user_given_tag, commit_message, executed_def_version_id
       FROM Versions WHERE version_id = ?`,
    ).get(newDbVersionId) as any

    if (!row) throw new Error('Failed to fetch version after creation.')

    return {
      id: row.version_id,
      taskId: row.task_id,
      type: row.version_type_tag as VersionType,
      asset_content_hash: row.asset_content_hash,
      parent_version_id: row.parent_version_id,
      executed_def_version_id: row.executed_def_version_id,
      timestamp_created: row.timestamp_created,
      user_given_tag: row.user_given_tag,
      commit_message: row.commit_message,
    }
  })
}

// Legacy orchestration logic has been moved to _legacy/orchestration.ts
// This logic should be implemented in the pipeline-runner (Workflow Engine)

// v12 Handle-Based API: Request execution and return a stable Handle ID
export const requestExecution = async (
  _parent: unknown,
  args: { actionId: ActionId, input: DictAsset },
): Promise<TraceId> => {
  const { actionId, input } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  const handleId = generator.generate()
  const timestamp = getTimestampFromTraceId(handleId)

  const inputAssetId = await store(input)

  // Pre-reads (outside serializer)
  const existingTaskId = findExistingTask(db, actionId, inputAssetId)
  const workflowInstanceTaskId = existingTaskId || generator.generate()

  // For user-defined actions, check if it has a workflow definition
  let taskDescription = `Execution of ${actionId}`
  if (!isSystemAction(actionId)) {
    const actionDefTaskRow = db.prepare(
      `SELECT current_version_id FROM Tasks WHERE task_id = ?`,
    ).get(actionId) as TaskRow | undefined
    const isWorkflowAction = actionDefTaskRow && actionDefTaskRow.current_version_id
    taskDescription = isWorkflowAction
      ? `Workflow execution of ${actionId}`
      : `Compute execution of ${actionId}`
  }
  else {
    taskDescription = `Execution of system action ${actionId}`
  }

  // All writes in a single serialized transaction
  return withTransaction('requestExecution', (db) => {
    // Create ExecutionHandle mapping
    db.prepare(
      `INSERT INTO ExecutionHandles (handle_id, task_id, created_at, created_by, description)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(handleId, workflowInstanceTaskId, timestamp, 'system', `Execution of ${actionId}`)

    // If task already exists, skip creation
    if (existingTaskId) {
      console.log(`ℹ️  Reusing existing task: ${existingTaskId} for action=${actionId}`)
      return handleId
    }

    // Create WI Task + TaskExecutionState
    createTaskWithExecutionStateInTransaction(
      db,
      workflowInstanceTaskId,
      actionId,
      inputAssetId,
      `Execution of ${actionId}`,
      taskDescription,
      timestamp,
    )

    return handleId
  })
}

// Legacy mutation - to be removed after migration
export const requestWorkflowRevision = async (
  _parent: unknown,
  args: { actionId: TraceId, input: DictAsset },
): Promise<WorkflowRevision> => {
  const { actionId, input } = args
  const db = getDB()
  const generator = getOperationTraceIdGenerator()

  const inputAssetId = await store(input)

  const workflowInstanceTaskId = generator.generate()
  const newRevisionId = generator.generate()
  const timestamp = getTimestampFromTraceId(newRevisionId)

  // Pre-read: get executed definition version (read-only, outside serializer)
  const actionDefTaskRow = db.prepare(
    `SELECT current_version_id FROM Tasks WHERE task_id = ?`,
  ).get(actionId) as TaskRow | undefined

  if (!actionDefTaskRow || !actionDefTaskRow.current_version_id) {
    throw new Error(`Action definition task ${actionId} not found or has no current_version_id.`)
  }
  const executedDefVersionId = actionDefTaskRow.current_version_id as TraceId

  return withTransaction('requestWorkflowRevision', (db) => {
    db.prepare(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, timestamp_created, current_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowInstanceTaskId, default_scope_id, actionId, inputAssetId,
      `Execution of ${actionId}`, timestamp, newRevisionId)

    db.prepare(
      `INSERT INTO Versions (version_id, task_id, version_type_tag, executed_def_version_id, timestamp_created, asset_content_hash, parent_version_id)
       VALUES (?, ?, 'REVISION', ?, ?, ?, ?)`,
    ).run(newRevisionId, workflowInstanceTaskId, executedDefVersionId, timestamp, null, null)

    return {
      id: newRevisionId,
      status: 'INITIALIZED',
      createdAt: timestamp,
      nodes: [],
    }
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
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = DatabaseQueries.getWorkflowTaskFromHandle(handleId)

    // 3. Find the required_task_id for this node (read-only, outside transaction)
    const defaultContext = await getDefaultContextAssetId()
    const contextHash = contextAssetHash || defaultContext

    // 4-5. All writes in a single transaction
    withTransaction('requestNodeRerun', (db) => {
      const newRevisionId = generator.generate()
      const timestamp = getTimestampFromTraceId(newRevisionId)

      // Duplicate workflow revision node states
      InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(db, {
        parentRevisionId: currentRevisionId,
        newRevisionId,
      })

      console.log(
        `✅ Duplicated node states: ${currentRevisionId} → ${newRevisionId}`,
      )

      const nodeStateRow = db.prepare(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
      ).get(newRevisionId, nodeId, contextHash) as any

      if (!nodeStateRow) {
        throw new Error(
          `Node ${nodeId} not found in workflow revision ${newRevisionId}`,
        )
      }

      const requiredTaskId = nodeStateRow.required_task_id
      if (!requiredTaskId) {
        throw new Error(`Node ${nodeId} has no required_task_id`)
      }

      // Finalize revision fork + refresh task
      InternalDatabaseOperations.finalizeRevisionFork(db, {
        taskId: wiTaskId,
        parentRevisionId: currentRevisionId,
        newRevisionId,
        timestamp,
        triggerReason: commitMessage || `Rerun request for node ${nodeId}`,
      })
      executeRefreshTaskInternal(db, requiredTaskId, {
        clearVersion: true,
      })
      InternalDatabaseOperations.updateNodeRuntimeStatus(db, {
        workflowRevisionId: newRevisionId,
        nodeId: nodeId,
        contextAssetHash: contextHash,
        runtimeStatus: 'RUNNING',
      })

      console.log(
        `✅ Forked revision and refreshed task ${requiredTaskId} for node ${nodeId} rerun`,
      )
    })

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
  const generator = getOperationTraceIdGenerator()

  console.log(`🔄 requestStaleNodesUpdate called for handle ${handleId}`)

  try {
    // Step 1-2: Get workflow task and current revision from handle
    const { wiTaskId, currentRevisionId }
      = DatabaseQueries.getWorkflowTaskFromHandle(handleId)
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
    const commandAssetId = await store(commandParams as DictAsset)

    // Output includes NEW revision ID - the result of the update operation
    const outputAsset = {
      newRevisionId,
      wiTaskId,
      staleNodeIds: nodeIds || null,
      parentRevisionId: currentRevisionId,
    }
    const outputAssetId = await store(outputAsset as DictAsset)

    // Steps 5-11: All writes in a single transaction
    withTransaction('requestStaleNodesUpdate', (db) => {
      // Step 5: Create Job Task
      db.prepare(
        `INSERT INTO Tasks (
          task_id, scope_id, action_id, inputs_content_hash,
          name, description, timestamp_created
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobTaskId,
        default_scope_id,
        actionIdToDbFormat(SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE),
        commandAssetId,
        'Update stale nodes',
        `Update stale nodes in workflow ${wiTaskId}`,
        jobTimestamp,
      )

      // Step 6: Duplicate workflow revision node states
      InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(db, {
        parentRevisionId: currentRevisionId,
        newRevisionId,
      })

      console.log(
        `✅ Duplicated node states: ${currentRevisionId} → ${newRevisionId}`,
      )

      // Step 8: Create OUTPUT version for Job Task
      db.prepare(
        `INSERT INTO Versions (
          version_id, task_id, version_type_tag, asset_content_hash,
          parent_version_id, timestamp_created, commit_message
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(outputVersionId, jobTaskId, 'OUTPUT', outputAssetId, outputTimestamp, 'Revision created')

      // Step 9: Update Job Task's current_version_id
      db.prepare(
        `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
      ).run(outputVersionId, jobTaskId)

      // Step 10: Finalize revision fork
      InternalDatabaseOperations.finalizeRevisionFork(db, {
        taskId: wiTaskId,
        parentRevisionId: currentRevisionId,
        newRevisionId,
        timestamp: revisionTimestamp,
        triggerReason: 'Update stale nodes',
      })

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

      db.prepare(
        `INSERT INTO EventLog (
          event_id, topic, payload, timestamp_created
        ) VALUES (?, ?, ?, ?)`,
      ).run(eventId, 'stale_update_revision_created', eventPayload, eventTimestamp)

      console.log(`✅ Stale update job completed atomically`)
      console.log(`📸 New revision: ${newRevisionId}`)
      console.log(`📋 Job ID: ${jobTaskId}`)
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
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle (read-only, outside transaction)
    const { wiTaskId, currentRevisionId }
      = DatabaseQueries.getWorkflowTaskFromHandle(handleId)
    const defaultContext = await getDefaultContextAssetId()

    // 3-6. All writes in a single transaction
    withTransaction('submitPlayerInput', (db) => {
      const newRevisionId = generator.generate()
      const timestamp = getTimestampFromTraceId(newRevisionId)

      // Duplicate workflow revision node states
      InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(db, {
        parentRevisionId: currentRevisionId,
        newRevisionId,
      })

      console.log(
        `🔀 Forked revision for submitPlayerInput: ${currentRevisionId} → ${newRevisionId}`,
      )

      // Read node state (within transaction)
      const nodeState = db.prepare(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
      ).get(newRevisionId, nodeId, contextAssetHash || defaultContext) as any

      if (!nodeState?.required_task_id) {
        throw new Error(`Node ${nodeId} has no task assigned`)
      }

      // Finalize fork + update node + emit event
      InternalDatabaseOperations.finalizeRevisionFork(db, {
        taskId: wiTaskId,
        parentRevisionId: currentRevisionId,
        newRevisionId,
        timestamp,
        triggerReason: `Player input for node ${nodeId}`,
      })

      InternalDatabaseOperations.updateNodeRuntimeStatus(db, {
        workflowRevisionId: newRevisionId,
        nodeId: nodeId,
        contextAssetHash: contextAssetHash || defaultContext,
        runtimeStatus: 'IDLE',
      })

      console.log(`✅ Updated node ${nodeId} to IDLE state after player input`)

      const eventProducer = new SqliteEventProducer()
      eventProducer.produce(
        'task_player_submitted',
        {
          task_id: nodeState.required_task_id,
          workflow_task_id: wiTaskId,
          workflow_revision_id: newRevisionId,
          node_id: nodeId,
          context_asset_hash: contextAssetHash || defaultContext,
          output_asset_id: outputAssetId,
          commit_message: commitMessage || `Player input for node ${nodeId}`,
        },
        db,
      )

      console.log(`✅ Emitted task_player_submitted event for node ${nodeId}`)
    })

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
  const generator = getOperationTraceIdGenerator()

  const jobId = generator.generate()

  try {
    // 1-2. Get workflow task and current revision from handle (read-only, outside transaction)
    const { wiTaskId, currentRevisionId }
      = DatabaseQueries.getWorkflowTaskFromHandle(handleId)
    const defaultContext = await getDefaultContextAssetId()

    // 3-6. All writes in a single transaction
    withTransaction('failPlayerTask', (db) => {
      const newRevisionId = generator.generate()
      const timestamp = getTimestampFromTraceId(newRevisionId)

      // Duplicate workflow revision node states
      InternalDatabaseOperations.duplicateWorkflowRevisionNodeStates(db, {
        parentRevisionId: currentRevisionId,
        newRevisionId,
      })

      console.log(
        `🔀 Forked revision for failPlayerTask: ${currentRevisionId} → ${newRevisionId}`,
      )

      // Read node state (within transaction)
      const nodeState = db.prepare(
        `SELECT required_task_id FROM WorkflowRevisionNodeStates
         WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
      ).get(newRevisionId, nodeId, contextAssetHash || defaultContext) as any

      if (!nodeState?.required_task_id) {
        throw new Error(`Node ${nodeId} has no task assigned`)
      }

      // Finalize fork + update node + emit event
      InternalDatabaseOperations.finalizeRevisionFork(db, {
        taskId: wiTaskId,
        parentRevisionId: currentRevisionId,
        newRevisionId,
        timestamp,
        triggerReason: `Player task failed: ${reason}`,
      })

      InternalDatabaseOperations.updateNodeRuntimeStatus(db, {
        workflowRevisionId: newRevisionId,
        nodeId: nodeId,
        contextAssetHash: contextAssetHash || defaultContext,
        runtimeStatus: 'FAILED',
      })

      console.log(
        `✅ Updated node ${nodeId} to FAILED state after player failure`,
      )

      const eventProducer = new SqliteEventProducer()
      eventProducer.produce(
        'task_player_failed',
        {
          task_id: nodeState.required_task_id,
          workflow_task_id: wiTaskId,
          workflow_revision_id: newRevisionId,
          node_id: nodeId,
          context_asset_hash: contextAssetHash || defaultContext,
          reason: reason,
        },
        db,
      )

      console.log(`✅ Emitted task_player_failed event for node ${nodeId}`)
    })

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
      metaAssetHash: update.metaAssetHash as AssetId | undefined,
    }))

    console.log(`🔍 [RESOLVER] Transformed updates:`)
    transformedUpdates.forEach((update, idx) => {
      console.log(
        `🔍 [RESOLVER] Transformed ${idx}: nodeId=${update.nodeId}, lastInputsHash=${update.lastInputsHash || 'undefined'}`,
      )
    })

    const result = ExternalDatabaseMutations.updateNodeStates(
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

export const createAction = (
  _parent: unknown,
  args: { name: string, description: string },
): Action => {
  const { name, description } = args
  const generator = getOperationTraceIdGenerator()

  const actionTaskId = generator.generate()
  const timestamp = getTimestampFromTraceId(actionTaskId)

  return withTransaction('createAction', (db) => {
    db.prepare(
      `INSERT INTO Tasks (task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(actionTaskId, default_scope_id, actionIdToDbFormat(SYSTEM_ACTIONS.CORE_DEFINE_ACTION),
      null, name, description, timestamp)

    return {
      id: actionTaskId as ActionId,
      name,
      description,
      currentVersion: null,
      createdAt: timestamp,
    }
  })
}

export const createWorkflowDefinitionVersion = async (
  _parent: unknown,
  args: {
    actionId: TraceId
    workflowDefinition: DictAsset
    commitMessage?: string | null
  },
): Promise<Version> => {
  const { actionId, workflowDefinition, commitMessage } = args
  const generator = getOperationTraceIdGenerator()

  const workflowAssetId = await store(workflowDefinition)

  const versionId = generator.generate()
  const timestamp = getTimestampFromTraceId(versionId)

  return withTransaction('createWorkflowDefinitionVersion', (db) => {
    db.prepare(
      `INSERT INTO Versions (version_id, task_id, version_type_tag, asset_content_hash, timestamp_created, commit_message)
       VALUES (?, ?, 'WORKFLOW_DEFINITION', ?, ?, ?)`,
    ).run(versionId, actionId, workflowAssetId, timestamp, commitMessage || 'Workflow definition created')

    db.prepare(
      `UPDATE Tasks SET current_version_id = ? WHERE task_id = ?`,
    ).run(versionId, actionId)

    return {
      id: versionId,
      taskId: actionId,
      type: VersionTypeEnum.WorkflowDefinition,
      asset_content_hash: workflowAssetId,
      parent_version_id: null,
      executed_def_version_id: null,
      timestamp_created: timestamp,
      user_given_tag: null,
      commit_message: commitMessage || 'Workflow definition created',
    }
  })
}

// --- v10 Worker API Mutations ---

export const scheduleTaskForExecution = (
  _parent: unknown,
  args: { taskId: TraceId },
): TaskExecutionState => {
  const { taskId } = args

  try {
    const result
      = ExternalDatabaseMutations.scheduleTaskForExecution(taskId)
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

export const claimTask = (
  _parent: unknown,
  args: { taskId: TraceId, workerId: string, ttl: number },
): TaskExecutionState | null => {
  const { taskId, workerId, ttl } = args

  // Import the new database operations

  try {
    const result = ExternalDatabaseMutations.claimTask(
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

export const reportTaskSuccess = (
  _parent: unknown,
  args: { taskId: TraceId, resultVersionId: TraceId, workerId: string },
): TaskExecutionState => {
  const { taskId, resultVersionId, workerId } = args

  // Import the new database operations

  try {
    const result = ExternalDatabaseMutations.reportTaskSuccess(
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

export const reportTaskFailure = (
  _parent: unknown,
  args: { taskId: TraceId, errorVersionId: TraceId, workerId: string },
): TaskExecutionState => {
  const { taskId, errorVersionId, workerId } = args

  try {
    const result = ExternalDatabaseMutations.reportTaskFailure(
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
export const claimWorkflowTask = (
  _parent: unknown,
  args: { taskId: TraceId, workerId: string, ttl: number },
): TaskExecutionState | null => {
  const { taskId, workerId, ttl } = args
  const generator = getOperationTraceIdGenerator() // Reset context for new operation

  // Import the new database operations

  try {
    // Generate revision version ID for workflow revision tracking
    const revisionVersionId = generator.generate()
    const timestamp = getTimestampFromTraceId(revisionVersionId)

    // Use the new external mutation (automatically serialized)
    const result = ExternalDatabaseMutations.claimWorkflowTask(
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

export const refreshTask = (
  _parent: unknown,
  args: { taskId: TraceId },
): TaskExecutionState => {
  const { taskId } = args

  try {
    const result = ExternalDatabaseMutations.refreshTask(taskId)

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
export const forkWorkflowRevision = (
  _parent: unknown,
  args: {
    taskId: TraceId
    currentRevisionId: TraceId
    triggerReason?: string | null
  },
): TraceId => {
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
  ExternalDatabaseMutations.forkRevision({
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
  eventProducer.produce(
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
export const setMergeAccumulator = (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
    accumulatorData: DictAsset
  },
): boolean => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId, accumulatorData } = args

  return withTransaction('setMergeAccumulator', (db) => {
    const insertedJsonString = encodeToString(accumulatorData)
    db.prepare(
      `INSERT OR REPLACE INTO PipelineMergeAccumulator
       (pipeline_id, workflow_revision_id, context_asset_hash, node_id, accumulator_json, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))`,
    ).run(pipelineId, workflowRevisionId, contextAssetHash, nodeId, insertedJsonString)
    return true
  })
}

/**
 * Atomically merge update: read current state, update one key, write back
 * Returns the updated accumulator state
 * Used when merge node receives partial input
 */
export const mergeMergeAccumulator = (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
    key: string
    value: AssetValue
  },
): DictAsset => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId, key, value } = args

  return withTransaction('mergeMergeAccumulator', (db) => {
    // Read current accumulator
    const row = db.prepare(
      `SELECT accumulator_json FROM PipelineMergeAccumulator
       WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
    ).get(pipelineId, workflowRevisionId, contextAssetHash, nodeId) as any

    const current: DictAsset = row?.accumulator_json
      ? decodeFromString(row.accumulator_json) as DictAsset
      : {}

    current[key] = value
    const mergedJsonString = encodeToString(current)

    // Upsert back to database
    db.prepare(
      `INSERT OR REPLACE INTO PipelineMergeAccumulator
       (pipeline_id, workflow_revision_id, context_asset_hash, node_id, accumulator_json, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))`,
    ).run(pipelineId, workflowRevisionId, contextAssetHash, nodeId, mergedJsonString)

    return decodeFromString(mergedJsonString) as DictAsset
  })
}

/**
 * Delete merge accumulator when task is scheduled
 */
export const deleteMergeAccumulator = (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
  },
): boolean => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId } = args

  return serializeMutation('deleteMergeAccumulator', () => {
    const db = getDB()
    db.prepare(
      `DELETE FROM PipelineMergeAccumulator
       WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
    ).run(pipelineId, workflowRevisionId, contextAssetHash, nodeId)
    return true
  })
}

/**
 * Save or update an interceptor session
 * Creates a new session if sessionId doesn't exist, updates if it does.
 */
export const saveInterceptorSession = (
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
): {
  sessionId: string
  sessionTaskId: Scalars['TraceId']['output']
  computationTaskId: Scalars['TraceId']['output']
  currentRevisionId: Scalars['TraceId']['output']
  referenceContextJson: string | null
  toolCallMappingJson: string | null
  createdAt: number
  lastActivity: number
} => {
  const { input } = args
  const now = Date.now()

  return serializeMutation('saveInterceptorSession', () => {
    const db = getDB()

    // Use INSERT OR REPLACE to handle both insert and update
    db.prepare(
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
    ).run(
      input.sessionId,
      input.sessionTaskId,
      input.computationTaskId,
      input.currentRevisionId,
      input.referenceContextJson || null,
      input.toolCallMappingJson || null,
      now, // created_at - only used on INSERT
      now, // last_activity - updated on both INSERT and UPDATE
    )

    // Fetch the saved/updated row to return
    const row = db.prepare(
      `SELECT * FROM InterceptorSessions WHERE session_id = ?`,
    ).get(input.sessionId) as {
      session_id: string
      session_task_id: string
      computation_task_id: string
      current_revision_id: string
      reference_context_json: string | null
      tool_call_mapping_json: string | null
      created_at: number
      last_activity: number
    } | undefined

    if (!row) {
      throw new Error('Failed to save interceptor session')
    }

    return {
      sessionId: row.session_id,
      sessionTaskId: row.session_task_id as Scalars['TraceId']['output'],
      computationTaskId: row.computation_task_id as Scalars['TraceId']['output'],
      currentRevisionId: row.current_revision_id as Scalars['TraceId']['output'],
      referenceContextJson: row.reference_context_json,
      toolCallMappingJson: row.tool_call_mapping_json,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
    }
  })
}
