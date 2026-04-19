// Copyright (c) 2026 Wuji Labs Inc
import {
  type ActionId,
  decodeFromString,
  type DictAsset,
  isSystemAction,
  isTraceId,
  type UserActionId,
} from '@playtiss/core'
import {
  actionIdToDbFormat,
  getSystemAction,
  getSystemActionDefinitions,
  SYSTEM_ACTIONS,
} from 'playtiss'

import type {
  Action,
  ActionConnection,
  PageInfo,
  QueryGetActionDetailsArgs,
  QueryGetWorkflowRevisionNodeStateArgs,
  QueryListWorkflowRevisionNodeStatesByTaskArgs,
  RuntimeStatus,
  Scalars,
  Task,
  TaskConnection,
  TaskExecutionState,
  TaskExecutionStateConnection,
  Version,
  WorkflowRevision,
  WorkflowRevisionConnection,
  WorkflowRevisionNodeState,
  WorkflowRevisionNodeStateConnection,
} from '../__generated__/graphql.js'
import { getDB } from '../db.js'

// Representing TraceId and AssetId as string, as per their scalar definitions
type TraceId = Scalars['TraceId']['input']
type AssetId = Scalars['AssetId']['input']

/**
 * Pagination helper types
 */
interface PaginationArgs {
  first?: number | null
  after?: string | null
  last?: number | null
  before?: string | null
}

/**
 * Base64 encode/decode for cursors
 */
function encodeCursor(value: string): string {
  return Buffer.from(value).toString('base64')
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf-8')
}

/**
 * Converts ISO date string to timestamp number.
 */
// function toTimestamp(isoString: string): number {
//   return new Date(isoString).getTime();
// }

// v12 Handle-Based API: Get workflow revision status using stable handle ID
export const getWorkflowRevisionStatus = (
  _parent: unknown,
  args: { handleId: TraceId },
): WorkflowRevision | null => {
  const { handleId } = args
  const db = getDB()

  // First, get the WI Task ID from the handle
  const handleRow = db.prepare(`SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`).get(handleId) as { task_id: string } | undefined
  if (!handleRow) return null // Handle not found

  const wiTaskId = handleRow.task_id

  // Get active REVISION version (O(1) lookup via active_revision_id)
  const taskRow = db.prepare(`SELECT active_revision_id FROM Tasks WHERE task_id = ?`).get(wiTaskId) as { active_revision_id: string | null } | undefined
  if (!taskRow?.active_revision_id) return null

  const revisionId = taskRow.active_revision_id as TraceId

  // Use the existing getWorkflowRevision function to get the revision details
  return getWorkflowRevision(null, { revisionId })
}

// v12 Handle-Based API: Get execution result using stable handle ID
export const getExecutionResult = (
  _parent: unknown,
  args: { handleId: TraceId },
): Version | null => {
  const { handleId } = args
  const db = getDB()

  // First, get the WI Task ID from the handle
  const handleRow = db.prepare(`SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`).get(handleId) as { task_id: string } | undefined
  if (!handleRow) return null // Handle not found

  const wiTaskId = handleRow.task_id

  // Get the latest output or error version for this WI Task (using proper version lookup by type)
  const versionRefRow = db.prepare(
    `SELECT version_id, version_type_tag FROM Versions
     WHERE task_id = ? AND version_type_tag IN ('output', 'error')
     ORDER BY timestamp_created DESC
     LIMIT 1`,
  ).get(wiTaskId) as { version_id: string, version_type_tag: string } | undefined
  if (!versionRefRow) return null

  const currentVersionId = versionRefRow.version_id

  // Get the version details
  const versionRow = db.prepare(
    `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id,
            timestamp_created, user_given_tag, commit_message, executed_def_version_id
     FROM Versions WHERE version_id = ?`,
  ).get(currentVersionId) as DbVersionRow | undefined
  if (!versionRow) return null

  return {
    id: versionRow.version_id as TraceId,
    taskId: versionRow.task_id as TraceId,
    type: versionRow.version_type_tag as any,
    asset_content_hash:
      versionRow.asset_content_hash as AssetId | null,
    parent_version_id:
      versionRow.parent_version_id as TraceId | null,
    executed_def_version_id:
      versionRow.executed_def_version_id as TraceId | null,
    timestamp_created: versionRow.timestamp_created,
    user_given_tag: versionRow.user_given_tag,
    commit_message: versionRow.commit_message,
  }
}

export const getVersion = (
  _parent: unknown,
  args: { versionId: TraceId },
): Version | null => {
  const { versionId } = args
  const db = getDB()

  const versionRow = db.prepare(
    `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id,
            timestamp_created, user_given_tag, commit_message, executed_def_version_id
     FROM Versions WHERE version_id = ?`,
  ).get(versionId) as DbVersionRow | undefined
  if (!versionRow) return null

  return {
    id: versionRow.version_id as TraceId,
    taskId: versionRow.task_id as TraceId,
    type: versionRow.version_type_tag as any,
    asset_content_hash: versionRow.asset_content_hash as AssetId | null,
    parent_version_id: versionRow.parent_version_id as TraceId | null,
    executed_def_version_id:
      versionRow.executed_def_version_id as TraceId | null,
    timestamp_created: versionRow.timestamp_created,
    user_given_tag: versionRow.user_given_tag,
    commit_message: versionRow.commit_message,
  }
}

// DB Row Interfaces aligned with db.ts schema
interface DbTaskRow {
  task_id: string // PRIMARY KEY
  scope_id: string
  action_id: string
  inputs_content_hash: string | null
  name: string | null
  description: string | null
  current_version_id: string | null // FK to Versions.version_id
  timestamp_created: number // Milliseconds since epoch
}

interface DbVersionRow {
  version_id: string // PRIMARY KEY
  task_id: string // FK to Tasks.task_id
  version_type_tag: string // e.g., "output", "revision"
  asset_content_hash: string | null // FK to Assets.id
  parent_version_id: string | null // FK to Versions.version_id
  timestamp_created: number // Milliseconds since epoch
  user_given_tag: string | null
  commit_message: string | null
  executed_def_version_id: string | null // FK to Versions.version_id
}

export const getTask = (
  _parent: unknown,
  args: { taskId: TraceId },
): Task | null => {
  const { taskId } = args

  // getTask should only return user-created tasks, not system actions
  // If someone tries to query a system action with getTask, we should return null
  // They should use getActionDetails instead

  // Query database for user tasks only
  const db = getDB()
  const taskRow = db.prepare(
    `SELECT task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created, current_version_id
     FROM Tasks WHERE task_id = ?`,
  ).get(taskId) as DbTaskRow | undefined
  if (!taskRow) {
    return null
  }

  let currentGqlVersion: Version | null = null
  if (taskRow.current_version_id) {
    // Fetch the current version details
    const versionRow = db.prepare(
      `SELECT * FROM Versions WHERE version_id = ?`,
    ).get(taskRow.current_version_id) as DbVersionRow | undefined

    if (versionRow) {
      currentGqlVersion = {
        id: versionRow.version_id as TraceId,
        taskId: versionRow.task_id as TraceId,
        type: versionRow.version_type_tag.toUpperCase() as any, // TODO: Proper enum mapping
        asset_content_hash:
          versionRow.asset_content_hash as AssetId | null,
        parent_version_id: versionRow.parent_version_id as TraceId | null,
        executed_def_version_id:
          versionRow.executed_def_version_id as TraceId | null,
        timestamp_created: versionRow.timestamp_created, // Direct use of millisecond timestamp
        user_given_tag: versionRow.user_given_tag,
        commit_message: versionRow.commit_message,
      }
    }
  }

  const gqlTask: Task = {
    id: taskRow.task_id as TraceId,
    actionId: taskRow.action_id as UserActionId, // For user tasks, actionId is already a TraceId
    inputsContentHash: taskRow.inputs_content_hash as AssetId,
    name: taskRow.name,
    description: taskRow.description,
    createdAt: taskRow.timestamp_created, // Direct use of millisecond timestamp
    currentVersion: currentGqlVersion,
    // scope_id is not in GQL Task type
  }
  return gqlTask
}

export const getActionDetails = (
  _parent: unknown,
  args: QueryGetActionDetailsArgs,
): Action | null => {
  const { actionId } = args

  // Check if this is a system action first
  if (isSystemAction(actionId)) {
    const systemAction = getSystemAction(actionId)
    if (systemAction) {
      return {
        id: systemAction.id as ActionId,
        name: systemAction.name,
        description: systemAction.description,
        createdAt: 0, // System actions have no creation time
        currentVersion: null, // System actions have no versions
      }
    }
  }

  // If not a system action, check if this is a user-defined action (actionId is a task ID)
  if (isTraceId(actionId)) {
    const task = getTask(null, { taskId: actionId })
    if (task) {
      // Convert Task to Action (remove actionId field)
      return {
        id: task.id as ActionId,
        name: task.name,
        description: task.description,
        createdAt: task.createdAt,
        currentVersion: task.currentVersion,
      }
    }
  }

  return null
}

export const listRevisionsForTask = (
  _parent: unknown,
  args: { taskId: TraceId } & PaginationArgs,
): WorkflowRevisionConnection => {
  const { taskId } = args
  const db = getDB()
  const limit = args.first || 10
  const cursor = args.after ? decodeCursor(args.after) : null

  let whereClause = 'WHERE task_id = ? AND version_type_tag = \'REVISION\''
  const params: unknown[] = [taskId]

  if (cursor) {
    whereClause += ' AND version_id > ?'
    params.push(cursor)
  }

  const revisionVersionRows = db.prepare(
    `SELECT * FROM Versions ${whereClause} ORDER BY timestamp_created DESC LIMIT ?`,
  ).all(...params, limit + 1) as DbVersionRow[]

  const hasNextPage = revisionVersionRows.length > limit
  const versionRows = hasNextPage
    ? revisionVersionRows.slice(0, limit)
    : revisionVersionRows

  const workflowRevisions = versionRows.map((revisionVersionRow) => {
    const revisionId = revisionVersionRow.version_id as TraceId

    const nodeRows = db.prepare(
      `SELECT workflow_revision_id, node_id_in_workflow, context_asset_hash, required_task_id, last_used_version_id, last_inputs_hash, meta_asset_hash, dependency_status, runtime_status, error_message FROM WorkflowRevisionNodeStates WHERE workflow_revision_id = ?`,
    ).all(revisionId) as WorkflowRevisionNodeStateRowV12[]

    const nodes: WorkflowRevisionNodeState[] = nodeRows.map((nodeRow) => {
      let lastUsedVersion: Version | null = null
      const versionId = nodeRow.last_used_version_id

      if (versionId) {
        const version = db.prepare(
          `SELECT * FROM Versions WHERE version_id = ?`,
        ).get(versionId) as DbVersionRow | undefined
        if (version) {
          lastUsedVersion = {
            id: version.version_id as TraceId,
            taskId: version.task_id as TraceId,
            type: version.version_type_tag.toUpperCase() as any,
            asset_content_hash:
              version.asset_content_hash as AssetId | null,
            parent_version_id:
              version.parent_version_id as TraceId | null,
            executed_def_version_id:
              version.executed_def_version_id as TraceId | null,
            timestamp_created: version.timestamp_created,
            user_given_tag: version.user_given_tag,
            commit_message: version.commit_message,
          }
        }
      }
      return {
        workflowRevisionId: nodeRow.workflow_revision_id as TraceId,
        nodeIdInWorkflow: nodeRow.node_id_in_workflow,
        contextAssetHash: nodeRow.context_asset_hash as AssetId,
        requiredTaskId: nodeRow.required_task_id as TraceId | null,
        metaAssetHash: nodeRow.meta_asset_hash as AssetId | null,
        dependencyStatus: nodeRow.dependency_status as any,
        runtimeStatus: nodeRow.runtime_status as any,
        lastUsedVersion: lastUsedVersion,
      }
    })

    let overallStatus = 'UNKNOWN'
    if (nodes.length === 0) {
      // No node states - this could mean:
      // 1. Workflow hasn't started yet
      // 2. Workflow completed and node states were cleaned up
      // 3. Simple workflow with no intermediate nodes
      overallStatus = 'COMPLETED'
    }
    else if (nodes.every(n => n.runtimeStatus === 'IDLE')) {
      overallStatus = 'COMPLETED'
    }
    else if (nodes.some(n => n.runtimeStatus === 'FAILED')) {
      overallStatus = 'FAILED'
    }
    else if (nodes.some(n => n.runtimeStatus === 'RUNNING')) {
      overallStatus = 'RUNNING'
    }

    return {
      id: revisionId,
      status: overallStatus,
      createdAt: revisionVersionRow.timestamp_created,
      nodes: nodes,
    }
  })

  const edges = workflowRevisions.map(revision => ({
    cursor: encodeCursor(revision.id),
    node: revision,
  }))

  const pageInfo: PageInfo = {
    hasNextPage,
    hasPreviousPage: cursor !== null,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

export const getRevision = (
  _parent: unknown,
  args: { versionId: TraceId },
): WorkflowRevision | null => {
  const { versionId } = args

  // The versionId should be a REVISION version ID, which corresponds to a WorkflowRevision
  // We can reuse the existing getWorkflowRevision function
  return getWorkflowRevision(null, { revisionId: versionId })
}

export const findProcessableRevisions = (
  _parent: unknown,
  args: PaginationArgs,
): WorkflowRevisionConnection => {
  const limit = args.first || 10
  const cursor = args.after ? decodeCursor(args.after) : null
  const db = getDB()

  let baseQuery = `
    SELECT DISTINCT wrns.workflow_revision_id, MIN(v.timestamp_created) as min_created_at
    FROM WorkflowRevisionNodeStates wrns
    JOIN Versions v ON wrns.workflow_revision_id = v.version_id AND v.version_type_tag = 'REVISION'
    WHERE wrns.runtime_status = 'PendingPlayerInput' OR wrns.runtime_status = 'Idle'
  `

  const params: unknown[] = []
  if (cursor) {
    baseQuery += ` AND wrns.workflow_revision_id > ?`
    params.push(cursor)
  }

  baseQuery += `
    GROUP BY wrns.workflow_revision_id
    ORDER BY min_created_at ASC
    LIMIT ?
  `
  params.push(limit + 1)

  const distinctRevisionIdRows = db.prepare(baseQuery).all(...params) as { workflow_revision_id: string, min_created_at: string }[]

  const hasNextPage = distinctRevisionIdRows.length > limit
  const revisionIdRows = hasNextPage
    ? distinctRevisionIdRows.slice(0, limit)
    : distinctRevisionIdRows

  const workflowRevisions: WorkflowRevision[] = []
  for (const revisionIdRow of revisionIdRows) {
    const revisionId = revisionIdRow.workflow_revision_id as TraceId
    const workflowRevision = getWorkflowRevision(null, {
      revisionId,
    })
    if (workflowRevision) {
      workflowRevisions.push(workflowRevision)
    }
  }

  const edges = workflowRevisions.map(revision => ({
    cursor: encodeCursor(revision.id),
    node: revision,
  }))

  const pageInfo: PageInfo = {
    hasNextPage,
    hasPreviousPage: cursor !== null,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

// Add new paginated functions
export const listTasksByAction = (
  _parent: unknown,
  args: { actionId: ActionId } & PaginationArgs,
): TaskConnection => {
  const db = getDB()

  // Determine pagination direction
  const isReverse = args.last !== null && args.last !== undefined
  const limit = isReverse ? args.last! : args.first || 10

  // Decode both cursors independently to support bounded range queries
  const beforeCursor = args.before ? decodeCursor(args.before) : null
  const afterCursor = args.after ? decodeCursor(args.after) : null

  let whereClause = 'WHERE action_id = ?'
  const params: unknown[] = [actionIdToDbFormat(args.actionId)]

  // Support both cursors simultaneously for bounded range queries
  if (beforeCursor) {
    whereClause += ' AND task_id < ?'
    params.push(beforeCursor)
  }
  if (afterCursor) {
    whereClause += ' AND task_id > ?'
    params.push(afterCursor)
  }

  const orderDirection = isReverse ? 'DESC' : 'ASC'

  const rows = db.prepare(
    `SELECT task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created, current_version_id
     FROM Tasks ${whereClause}
     ORDER BY task_id ${orderDirection}
     LIMIT ?`,
  ).all(...params, limit + 1) as DbTaskRow[] // Get one extra to check for hasNextPage/hasPreviousPage

  const hasMore = rows.length > limit
  let taskRows = hasMore ? rows.slice(0, limit) : rows

  // Reverse results back to normal order if doing reverse pagination
  // Per Relay spec: "the edge closest to cursor must come last" for before: cursor
  if (isReverse) {
    taskRows = taskRows.reverse()
  }

  const tasks = taskRows.map((taskRow) => {
    let currentGqlVersion: Version | null = null
    if (taskRow.current_version_id) {
      const versionRow = db.prepare(
        `SELECT * FROM Versions WHERE version_id = ?`,
      ).get(taskRow.current_version_id) as DbVersionRow | undefined
      if (versionRow) {
        currentGqlVersion = {
          id: versionRow.version_id as TraceId,
          taskId: versionRow.task_id as TraceId,
          type: versionRow.version_type_tag.toUpperCase() as any,
          asset_content_hash:
            versionRow.asset_content_hash as AssetId | null,
          parent_version_id:
            versionRow.parent_version_id as TraceId | null,
          executed_def_version_id:
            versionRow.executed_def_version_id as TraceId | null,
          timestamp_created: versionRow.timestamp_created,
          user_given_tag: versionRow.user_given_tag,
          commit_message: versionRow.commit_message,
        }
      }
    }

    return {
      id: taskRow.task_id as TraceId,
      actionId: taskRow.action_id as ActionId,
      inputsContentHash: taskRow.inputs_content_hash as AssetId,
      name: taskRow.name,
      description: taskRow.description,
      createdAt: taskRow.timestamp_created,
      currentVersion: currentGqlVersion,
    }
  })

  const edges = tasks.map(task => ({
    cursor: encodeCursor(task.id),
    node: task,
  }))

  const pageInfo: PageInfo = {
    hasNextPage: isReverse ? beforeCursor !== null : hasMore,
    hasPreviousPage: isReverse ? hasMore : afterCursor !== null,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

export const listActions = (
  _parent: unknown,
  args: PaginationArgs,
): ActionConnection => {
  const db = getDB()

  // For simplicity, we'll implement forward pagination only
  const limit = args.first === 0 ? 0 : args.first || 10 // Handle zero explicitly
  const cursor = args.after ? decodeCursor(args.after) : null

  // Fetch user-defined actions from database
  const actionTaskRows = db.prepare(
    `SELECT task_id, name, description, action_id, inputs_content_hash, timestamp_created, current_version_id
        FROM Tasks WHERE action_id = ?
        ORDER BY task_id ASC`,
  ).all(actionIdToDbFormat(SYSTEM_ACTIONS.CORE_DEFINE_ACTION)) as DbTaskRow[]

  const userDefinedActions: Action[] = actionTaskRows.map((taskRow) => {
    let currentGqlVersion: Version | null = null
    if (taskRow.current_version_id) {
      const versionRow = db.prepare(
        `SELECT * FROM Versions WHERE version_id = ?`,
      ).get(taskRow.current_version_id) as DbVersionRow | undefined
      if (versionRow) {
        currentGqlVersion = {
          id: versionRow.version_id as TraceId,
          taskId: versionRow.task_id as TraceId,
          type: versionRow.version_type_tag.toUpperCase() as any,
          asset_content_hash:
              versionRow.asset_content_hash as AssetId | null,
          parent_version_id:
              versionRow.parent_version_id as TraceId | null,
          executed_def_version_id:
              versionRow.executed_def_version_id as TraceId | null,
          timestamp_created: versionRow.timestamp_created,
          user_given_tag: versionRow.user_given_tag,
          commit_message: versionRow.commit_message,
        }
      }
    }

    return {
      id: taskRow.task_id as ActionId,
      name: taskRow.name,
      description: taskRow.description,
      createdAt: taskRow.timestamp_created,
      currentVersion: currentGqlVersion,
    }
  })

  // Add system actions
  const systemActions: Action[] = Object.values(
    getSystemActionDefinitions(),
  ).map(systemAction => ({
    id: systemAction.id as ActionId,
    name: systemAction.name,
    description: systemAction.description,
    createdAt: 0,
    currentVersion: null,
  }))

  // Combine and sort all actions by ID
  const allActions = [...systemActions, ...userDefinedActions].sort(
    (a, b) => a.id.localeCompare(b.id),
  )

  // Apply cursor filtering
  let startIndex = 0
  if (cursor) {
    const cursorIndex = allActions.findIndex(
      action => action.id > cursor!,
    )
    if (cursorIndex >= 0) {
      startIndex = cursorIndex
    }
    else {
      // Cursor is after all items, return empty
      startIndex = allActions.length
    }
  }

  // Get the requested page
  const endIndex = Math.min(startIndex + limit, allActions.length)
  const pageActions = allActions.slice(startIndex, endIndex)

  // Create edges
  const edges = pageActions.map(action => ({
    cursor: encodeCursor(action.id),
    node: action,
  }))

  // Create page info
  const pageInfo: PageInfo = {
    hasNextPage: endIndex < allActions.length,
    hasPreviousPage: startIndex > 0,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

interface WorkflowRevisionNodeStateRow {
  workflow_revision_id: string // Corresponds to the revisionId (Version id of type 'revision')
  node_id_in_workflow: string // nodeIdInWorkflow in GQL
  context_asset_hash: string // FK to Assets.asset_content_hash (v9 addition)
  required_task_id: string | null // FK to Tasks.task_id (v12 addition)
  last_used_version_id: string | null // FK to Versions.version_id
  last_inputs_hash: string | null // Stored inputs hash (v13 addition)
  meta_asset_hash: string | null // Stored meta slot values (^ prefix, v17 addition)
  dependency_status: string // "Fresh", "Stale"
  runtime_status: string // "Idle", "Running", "Failed", "PendingPlayerInput", "Blocked"
  error_message: string | null
}

// Row type for TaskExecutionStates table with joined data
interface TaskExecutionStateRow {
  task_id: string
  runtime_status: string // "PENDING", "RUNNING", "SUCCEEDED", "FAILED"
  claim_timestamp: number | null // Milliseconds since epoch
  claim_worker_id: string | null
  claim_ttl_seconds: number | null
  current_version_id: string | null // From Tasks table join
  version_type_tag: string | null // From Versions table join
}

// New v10 API: findRunnableTasks returns TaskExecutionState[]
export const findRunnableTasks = (
  _parent: unknown,
  args: {
    actionId?: ActionId | null
    first?: number | null
    after?: string | null
    last?: number | null
    before?: string | null
  },
): TaskExecutionStateConnection => {
  const db = getDB()

  // Determine pagination direction
  const isReverse = args.last !== null && args.last !== undefined
  const limit = isReverse ? args.last! : args.first || 10
  const cursor = isReverse
    ? args.before
      ? decodeCursor(args.before)
      : null
    : args.after
      ? decodeCursor(args.after)
      : null

  // A task is runnable if:
  // - runtime_status = 'PENDING' (waiting to be claimed)
  // - Not claimed or claim expired:
  //   - claim_timestamp IS NULL OR
  //   - (CURRENT_TIMESTAMP - claim_timestamp > claim_ttl_seconds)

  // Build WHERE clause dynamically based on filters using optimized columns
  // A task is runnable if:
  // 1. It's PENDING, OR
  // 2. It's RUNNING but the claim has expired (using precomputed expiration_time)
  const currentTime = Date.now()
  const whereClauses: string[] = [
    '('
    + 'runtime_status = \'PENDING\' OR '
    + '(runtime_status = \'RUNNING\' AND expiration_time IS NOT NULL AND ? > expiration_time)'
    + ')',
  ]
  const params: unknown[] = [currentTime]

  if (args.actionId) {
    whereClauses.push('tes.action_id = ?')
    params.push(actionIdToDbFormat(args.actionId))
  }

  if (cursor) {
    whereClauses.push(isReverse ? 'tes.task_id < ?' : 'tes.task_id > ?')
    params.push(cursor)
  }

  params.push(limit + 1)

  const orderDirection = isReverse ? 'DESC' : 'ASC'

  const query = `
    SELECT
      tes.task_id,
      tes.runtime_status,
      tes.claim_timestamp,
      tes.claim_worker_id,
      tes.claim_ttl_seconds,
      t.current_version_id,
      v.version_type_tag
    FROM TaskExecutionStates tes
    LEFT JOIN Tasks t ON tes.task_id = t.task_id
    LEFT JOIN Versions v ON t.current_version_id = v.version_id
    WHERE ${whereClauses.join(' AND ')}
      AND (t.current_version_id IS NULL OR v.version_type_tag NOT IN ('OUTPUT', 'ERROR'))
    ORDER BY tes.task_id ${orderDirection}
    LIMIT ?
  `

  const taskRows = db.prepare(query).all(...params) as TaskExecutionStateRow[]

  const hasMore = taskRows.length > limit
  let resultRows = hasMore
    ? taskRows.slice(0, limit)
    : taskRows

  // Reverse results back to normal order if doing reverse pagination
  // Per Relay spec: "the edge closest to cursor must come last" for before: cursor
  if (isReverse) {
    resultRows = resultRows.reverse()
  }

  const tasks: TaskExecutionState[] = resultRows.map((taskRow) => {
    // Log potential WAL consistency issues
    if (
      taskRow.current_version_id
      && taskRow.version_type_tag === 'OUTPUT'
      && taskRow.runtime_status !== 'SUCCEEDED'
    ) {
      console.warn(
        `⚠️  WAL consistency issue detected: Task ${taskRow.task_id} has OUTPUT version but runtime_status=${taskRow.runtime_status}`,
      )
    }

    return {
      taskId: taskRow.task_id as TraceId,
      runtimeStatus: taskRow.runtime_status as any,
      claim_timestamp: taskRow.claim_timestamp,
      claim_worker_id: taskRow.claim_worker_id,
      claim_ttl_seconds: taskRow.claim_ttl_seconds,
    }
  })

  const edges = tasks.map(task => ({
    cursor: encodeCursor(task.taskId),
    node: task,
  }))

  const pageInfo: PageInfo = {
    hasNextPage: isReverse ? cursor !== null : hasMore,
    hasPreviousPage: isReverse ? hasMore : cursor !== null,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

export const getWorkflowRevision = (
  _parent: unknown,
  args: { revisionId: TraceId },
): WorkflowRevision | null => {
  const { revisionId } = args
  const db = getDB()

  // 1. Fetch the revision Version record
  const versionRow = db.prepare(
    `SELECT * FROM Versions WHERE version_id = ? AND version_type_tag = 'REVISION'`,
  ).get(revisionId) as DbVersionRow | undefined
  if (!versionRow) {
    console.log(`No revision version found for revisionId ${revisionId}`)
    return null
  }

  // 2. Fetch related WorkflowRevisionNodeStates
  const nodeRows = db.prepare(
    `SELECT workflow_revision_id, node_id_in_workflow, context_asset_hash, required_task_id, last_used_version_id, last_inputs_hash, meta_asset_hash, dependency_status, runtime_status, error_message FROM WorkflowRevisionNodeStates WHERE workflow_revision_id = ?`,
  ).all(revisionId) as WorkflowRevisionNodeStateRow[]

  const nodes: WorkflowRevisionNodeState[] = nodeRows.map((nodeRow) => {
    let lastUsedVersion: Version | null = null
    const versionId = nodeRow.last_used_version_id

    if (versionId) {
      const version = db.prepare(
        `SELECT * FROM Versions WHERE version_id = ?`,
      ).get(versionId) as DbVersionRow | undefined
      if (version) {
        lastUsedVersion = {
          id: version.version_id as TraceId,
          taskId: version.task_id as TraceId,
          type: version.version_type_tag.toUpperCase() as any,
          asset_content_hash:
            version.asset_content_hash as AssetId | null,
          parent_version_id:
            version.parent_version_id as TraceId | null,
          executed_def_version_id:
            version.executed_def_version_id as TraceId | null,
          timestamp_created: version.timestamp_created, // Direct use of millisecond timestamp
          user_given_tag: version.user_given_tag,
          commit_message: version.commit_message,
        }
      }
    }

    return {
      workflowRevisionId: nodeRow.workflow_revision_id as TraceId,
      nodeIdInWorkflow: nodeRow.node_id_in_workflow,
      contextAssetHash: nodeRow.context_asset_hash as AssetId,
      requiredTaskId: nodeRow.required_task_id as TraceId | null,
      lastInputsHash: nodeRow.last_inputs_hash as AssetId | null,
      metaAssetHash: nodeRow.meta_asset_hash as AssetId | null,
      dependencyStatus: nodeRow.dependency_status as any,
      runtimeStatus: nodeRow.runtime_status as any,
      lastUsedVersion: lastUsedVersion,
    }
  })

  // 3. Derive WorkflowRevision status (placeholder logic)
  let overallStatus = 'UNKNOWN'
  if (nodes.every(n => n.runtimeStatus === 'IDLE')) {
    overallStatus = 'COMPLETED'
  }
  else if (nodes.some(n => n.runtimeStatus === 'FAILED')) {
    overallStatus = 'FAILED'
  }
  else if (nodes.some(n => n.runtimeStatus === 'RUNNING')) {
    overallStatus = 'RUNNING'
  }

  const workflowRevision: WorkflowRevision = {
    id: revisionId,
    status: overallStatus,
    createdAt: versionRow.timestamp_created, // Direct use of millisecond timestamp
    nodes: nodes,
  }
  return workflowRevision
}

// Interface for WorkflowRevisionNodeStates database row (v12 with required_task_id)
interface WorkflowRevisionNodeStateRowV12 {
  workflow_revision_id: string
  node_id_in_workflow: string
  context_asset_hash: string
  required_task_id: string | null
  last_used_version_id: string | null
  last_inputs_hash: string | null
  meta_asset_hash: string | null
  dependency_status: string
  runtime_status: string
  error_message: string | null
}

/**
 * Get specific workflow revision node state
 */
export const getWorkflowRevisionNodeState = (
  _parent: unknown,
  args: QueryGetWorkflowRevisionNodeStateArgs,
): WorkflowRevisionNodeState | null => {
  const { workflowRevisionId, nodeIdInWorkflow, contextAssetHash } = args
  const db = getDB()

  const row = db.prepare(
    `SELECT * FROM WorkflowRevisionNodeStates
     WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
  ).get(workflowRevisionId, nodeIdInWorkflow, contextAssetHash) as WorkflowRevisionNodeStateRowV12 | undefined
  if (!row) {
    return null
  }

  // Convert database row to GraphQL type
  const nodeState: WorkflowRevisionNodeState = {
    workflowRevisionId: row.workflow_revision_id as TraceId,
    nodeIdInWorkflow: row.node_id_in_workflow,
    contextAssetHash: row.context_asset_hash as AssetId,
    requiredTaskId: row.required_task_id as TraceId,
    dependencyStatus: row.dependency_status as any,
    runtimeStatus: row.runtime_status as any,
    lastUsedVersion: null, // TODO: Load version if needed
  }

  return nodeState
}

/**
 * List workflow revision node states by task ID (reverse lookup)
 */
export const listWorkflowRevisionNodeStatesByTask = (
  _parent: unknown,
  args: QueryListWorkflowRevisionNodeStatesByTaskArgs,
): WorkflowRevisionNodeStateConnection => {
  const { taskId, workflowRevisionId, first = 50, after, last, before } = args
  const db = getDB()

  // Validate pagination args
  if (first && last) {
    throw new Error('Cannot specify both first and last')
  }
  if (first && before) {
    throw new Error('Cannot specify both first and before')
  }
  if (last && after) {
    throw new Error('Cannot specify both last and after')
  }

  const limit = Math.min(first || last || 50, 100) // Cap at 100
  const isForward = Boolean(first || (!last && !before))

  // Build WHERE clause with optional workflow_revision_id filter
  let query = `SELECT * FROM WorkflowRevisionNodeStates WHERE required_task_id = ?`
  const params: unknown[] = [taskId]

  // Add optional workflow_revision_id filter for server-side filtering optimization
  if (workflowRevisionId) {
    query += ` AND workflow_revision_id = ?`
    params.push(workflowRevisionId)
  }

  // Add cursor filtering
  if (after) {
    const cursorValue = decodeCursor(after)
    query += ` AND (workflow_revision_id || '|' || node_id_in_workflow || '|' || context_asset_hash) > ?`
    params.push(cursorValue)
  }
  if (before) {
    const cursorValue = decodeCursor(before)
    query += ` AND (workflow_revision_id || '|' || node_id_in_workflow || '|' || context_asset_hash) < ?`
    params.push(cursorValue)
  }

  // Add ordering and limit
  query += ` ORDER BY workflow_revision_id ${isForward ? 'ASC' : 'DESC'}, node_id_in_workflow ${isForward ? 'ASC' : 'DESC'}, context_asset_hash ${isForward ? 'ASC' : 'DESC'}`
  query += ` LIMIT ?`
  params.push(limit + 1) // Fetch one extra to determine hasNextPage

  const rows = db.prepare(query).all(...params) as WorkflowRevisionNodeStateRowV12[]

  const nodeStates = [...rows]
  const hasMore = nodeStates.length > limit

  // Remove the extra record used for pagination detection
  if (hasMore) {
    nodeStates.pop()
  }

  // Convert to edges
  const edges = nodeStates.map((row) => {
    const cursor = encodeCursor(
      `${row.workflow_revision_id}|${row.node_id_in_workflow}|${row.context_asset_hash}`,
    )

    const node: WorkflowRevisionNodeState = {
      workflowRevisionId: row.workflow_revision_id as TraceId,
      nodeIdInWorkflow: row.node_id_in_workflow,
      contextAssetHash: row.context_asset_hash as AssetId,
      requiredTaskId: row.required_task_id as TraceId,
      dependencyStatus: row.dependency_status as any,
      runtimeStatus: row.runtime_status as any,
      lastUsedVersion: null, // TODO: Load version if needed
    }

    return {
      cursor,
      node,
    }
  })

  const pageInfo: PageInfo = {
    hasNextPage: isForward ? hasMore : false,
    hasPreviousPage: !isForward ? hasMore : false,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}

/**
 * List active workflow revision node states by task ID (reverse lookup)
 * Only returns node states from the latest (active) revision version of each workflow instance
 */
export const listActiveWorkflowRevisionNodeStatesByTask = (
  _parent: unknown,
  args: {
    taskId: TraceId
    first?: number | null
    after?: string | null
    last?: number | null
    before?: string | null
  },
): WorkflowRevisionNodeStateConnection => {
  const { taskId, first = 50, after, last, before } = args
  const db = getDB()

  // Validate pagination args
  if (first && last) {
    throw new Error('Cannot specify both first and last')
  }
  if (first && before) {
    throw new Error('Cannot specify both first and before')
  }
  if (last && after) {
    throw new Error('Cannot specify both last and after')
  }

  const limit = Math.min(first || last || 50, 100) // Cap at 100
  const isForward = Boolean(first || (!last && !before))

  // Build query that finds only active (latest revision) workflow revision node states
  // Strategy: Use O(1) active_revision_id pointer from Tasks table
  // This replaces expensive NOT EXISTS subquery with simple JOIN
  let query = `
    SELECT wrns.*
    FROM WorkflowRevisionNodeStates wrns
    INNER JOIN Tasks t ON wrns.workflow_revision_id = t.active_revision_id
    WHERE wrns.required_task_id = ?
  `

  const params: unknown[] = [taskId]

  // Add cursor filtering
  if (after) {
    const cursorValue = decodeCursor(after)
    query += ` AND (wrns.workflow_revision_id || '|' || wrns.node_id_in_workflow || '|' || wrns.context_asset_hash) > ?`
    params.push(cursorValue)
  }
  if (before) {
    const cursorValue = decodeCursor(before)
    query += ` AND (wrns.workflow_revision_id || '|' || wrns.node_id_in_workflow || '|' || wrns.context_asset_hash) < ?`
    params.push(cursorValue)
  }

  // Add ordering and limit
  query += ` ORDER BY wrns.workflow_revision_id ${isForward ? 'ASC' : 'DESC'}, wrns.node_id_in_workflow ${isForward ? 'ASC' : 'DESC'}, wrns.context_asset_hash ${isForward ? 'ASC' : 'DESC'}`
  query += ` LIMIT ?`
  params.push(limit + 1) // Fetch one extra to determine hasNextPage

  const rows = db.prepare(query).all(...params) as WorkflowRevisionNodeStateRowV12[]

  const nodeStates = [...rows]
  const hasMore = nodeStates.length > limit

  // Remove the extra record used for pagination detection
  if (hasMore) {
    nodeStates.pop()
  }

  // Convert to edges
  const edges = nodeStates.map((row) => {
    const cursor = encodeCursor(
      `${row.workflow_revision_id}|${row.node_id_in_workflow}|${row.context_asset_hash}`,
    )

    const node: WorkflowRevisionNodeState = {
      workflowRevisionId: row.workflow_revision_id as TraceId,
      nodeIdInWorkflow: row.node_id_in_workflow,
      contextAssetHash: row.context_asset_hash as AssetId,
      requiredTaskId: row.required_task_id as TraceId,
      dependencyStatus: row.dependency_status as any,
      runtimeStatus: row.runtime_status as any,
      lastUsedVersion: null, // TODO: Load version if needed
    }

    return {
      cursor,
      node,
    }
  })

  const pageInfo: PageInfo = {
    hasNextPage: isForward ? hasMore : false,
    hasPreviousPage: !isForward ? hasMore : false,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  }

  return {
    edges,
    pageInfo,
  }
}
/**
 * Get a specific node state from a workflow revision
 * Used by pipeline-runner to check if a node has already been executed
 */
export const getNodeState = (
  _parent: unknown,
  args: {
    workflowRevisionId: TraceId
    nodeId: string
    contextAssetHash: AssetId
  },
): WorkflowRevisionNodeState | null => {
  const { workflowRevisionId, nodeId, contextAssetHash } = args
  const db = getDB()

  const row = db.prepare(
    `SELECT * FROM WorkflowRevisionNodeStates
     WHERE workflow_revision_id = ?
       AND node_id_in_workflow = ?
       AND context_asset_hash = ?`,
  ).get(workflowRevisionId, nodeId, contextAssetHash) as WorkflowRevisionNodeStateRowV12 | undefined

  if (!row) {
    return null
  }

  // Map database row to GraphQL type
  const nodeState: WorkflowRevisionNodeState = {
    workflowRevisionId:
      row.workflow_revision_id as Scalars['TraceId']['output'],
    nodeIdInWorkflow: row.node_id_in_workflow,
    contextAssetHash:
      row.context_asset_hash as Scalars['AssetId']['output'],
    requiredTaskId: row.required_task_id as
    | Scalars['TraceId']['output']
    | null,
    lastUsedVersion: null, // TODO: Load version if needed
    lastInputsHash: row.last_inputs_hash as
    | Scalars['AssetId']['output']
    | null,
    metaAssetHash: row.meta_asset_hash as
    | Scalars['AssetId']['output']
    | null,
    dependencyStatus: row.dependency_status as 'FRESH' | 'STALE',
    runtimeStatus: row.runtime_status as RuntimeStatus,
  }

  return nodeState
}

/**
 * Get merge accumulator state (for debugging)
 * v14.1 addition for centralized merge node state management
 */
export const getMergeAccumulator = (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
  },
): DictAsset | null => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId } = args
  const db = getDB()

  const row = db.prepare(
    `SELECT accumulator_json FROM PipelineMergeAccumulator
     WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
  ).get(pipelineId, workflowRevisionId, contextAssetHash, nodeId) as { accumulator_json: string } | undefined

  if (!row?.accumulator_json) {
    return null
  }

  const result = decodeFromString(row.accumulator_json) as DictAsset
  return result
}

/**
 * Get task execution state - used to check if task is in terminal state (SUCCEEDED/FAILED)
 * for redelivery detection in pipeline-runner
 */
export const getTaskExecutionState = (
  _parent: unknown,
  args: { taskId: TraceId },
): TaskExecutionState | null => {
  const { taskId } = args
  const db = getDB()

  const row = db.prepare(
    `SELECT task_id, runtime_status, claim_timestamp, claim_worker_id, claim_ttl_seconds
     FROM TaskExecutionStates
     WHERE task_id = ?`,
  ).get(taskId) as {
    task_id: string
    runtime_status: string
    claim_timestamp: number | null
    claim_worker_id: string | null
    claim_ttl_seconds: number | null
  } | undefined

  if (!row) {
    return null
  }

  return {
    taskId: row.task_id as Scalars['TraceId']['output'],
    runtimeStatus: row.runtime_status as RuntimeStatus,
    claim_timestamp: row.claim_timestamp,
    claim_worker_id: row.claim_worker_id,
    claim_ttl_seconds: row.claim_ttl_seconds,
  }
}

/**
 * Get an interceptor session by session ID
 */
export const getInterceptorSession = (
  _parent: unknown,
  args: { sessionId: string },
): {
  sessionId: string
  sessionTaskId: Scalars['TraceId']['output']
  computationTaskId: Scalars['TraceId']['output']
  currentRevisionId: Scalars['TraceId']['output']
  referenceContextJson: string | null
  toolCallMappingJson: string | null
  createdAt: number
  lastActivity: number
} | null => {
  const { sessionId } = args
  const db = getDB()

  const row = db.prepare(
    `SELECT session_id, session_task_id, computation_task_id, current_revision_id,
            reference_context_json, tool_call_mapping_json, created_at, last_activity
     FROM InterceptorSessions
     WHERE session_id = ?`,
  ).get(sessionId) as {
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
    return null
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
}
