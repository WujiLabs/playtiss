// Copyright (c) 2026 Wuji Labs Inc
import {
  SYSTEM_ACTIONS,
  actionIdToDbFormat,
  getSystemAction,
  getSystemActionDefinitions,
  isSystemAction,
  type ActionId,
  type DictAsset,
} from 'playtiss'
import { decodeFromString } from 'playtiss/types/json'
import type { UserActionId } from 'playtiss/types/playtiss'
import { isTraceId } from 'playtiss/types/trace_id'
import type {
  Action,
  ActionConnection,
  PageInfo,
  Profile,
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

// TODO: Replace with actual user authentication logic in Phase 2
export const getProfile = (): Profile => {
  return {
    name: 'Default User',
  }
}

// v12 Handle-Based API: Get workflow revision status using stable handle ID
export const getWorkflowRevisionStatus = async (
  _parent: unknown,
  args: { handleId: TraceId },
): Promise<WorkflowRevision | null> => {
  const { handleId } = args
  const db = getDB()

  return new Promise<WorkflowRevision | null>((resolve, reject) => {
    // First, get the WI Task ID from the handle
    db.get(
      `SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`,
      [handleId],
      (err, handleRow: any) => {
        if (err)
          return reject(new Error(`Failed to fetch handle: ${err.message}`))
        if (!handleRow) return resolve(null) // Handle not found

        const wiTaskId = handleRow.task_id

        // Get active REVISION version (O(1) lookup via active_revision_id)
        db.get(
          `SELECT active_revision_id FROM Tasks WHERE task_id = ?`,
          [wiTaskId],
          (taskErr, taskRow: any) => {
            if (taskErr)
              return reject(
                new Error(`Failed to fetch active revision: ${taskErr.message}`),
              )
            if (!taskRow?.active_revision_id) return resolve(null)

            const revisionId = taskRow.active_revision_id

            // Use the existing getWorkflowRevision function to get the revision details
            getWorkflowRevision(null, { revisionId })
              .then(resolve)
              .catch(reject)
          },
        )
      },
    )
  })
}

// v12 Handle-Based API: Get execution result using stable handle ID
export const getExecutionResult = async (
  _parent: unknown,
  args: { handleId: TraceId },
): Promise<Version | null> => {
  const { handleId } = args
  const db = getDB()

  return new Promise<Version | null>((resolve, reject) => {
    // First, get the WI Task ID from the handle
    db.get(
      `SELECT task_id FROM ExecutionHandles WHERE handle_id = ?`,
      [handleId],
      (err, handleRow: any) => {
        if (err)
          return reject(new Error(`Failed to fetch handle: ${err.message}`))
        if (!handleRow) return resolve(null) // Handle not found

        const wiTaskId = handleRow.task_id

        // Get the latest output or error version for this WI Task (using proper version lookup by type)
        db.get(
          `SELECT version_id, version_type_tag FROM Versions 
           WHERE task_id = ? AND version_type_tag IN ('output', 'error') 
           ORDER BY timestamp_created DESC 
           LIMIT 1`,
          [wiTaskId],
          (taskErr, versionRow: any) => {
            if (taskErr)
              return reject(
                new Error(`Failed to fetch latest result: ${taskErr.message}`),
              )
            if (!versionRow) return resolve(null)

            const currentVersionId = versionRow.version_id

            // Get the version details
            db.get<DbVersionRow>(
              `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id, 
                      timestamp_created, user_given_tag, commit_message, executed_def_version_id
               FROM Versions WHERE version_id = ?`,
              [currentVersionId],
              (versionErr, versionRow) => {
                if (versionErr)
                  return reject(
                    new Error(`Failed to fetch version: ${versionErr.message}`),
                  )
                if (!versionRow) return resolve(null)

                resolve({
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
                })
              },
            )
          },
        )
      },
    )
  })
}

export const getVersion = async (
  _parent: unknown,
  args: { versionId: TraceId },
): Promise<Version | null> => {
  const { versionId } = args
  const db = getDB()

  return new Promise<Version | null>((resolve, reject) => {
    db.get<DbVersionRow>(
      `SELECT version_id, task_id, version_type_tag, asset_content_hash, parent_version_id, 
              timestamp_created, user_given_tag, commit_message, executed_def_version_id
       FROM Versions WHERE version_id = ?`,
      [versionId],
      (err, versionRow) => {
        if (err)
          return reject(new Error(`Failed to fetch version: ${err.message}`))
        if (!versionRow) return resolve(null)

        resolve({
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
        })
      },
    )
  })
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

export const getTask = async (
  _parent: unknown,
  args: { taskId: TraceId },
): Promise<Task | null> => {
  const { taskId } = args

  // getTask should only return user-created tasks, not system actions
  // If someone tries to query a system action with getTask, we should return null
  // They should use getActionDetails instead

  // Query database for user tasks only
  const db = getDB()
  return new Promise<Task | null>((resolve, reject) => {
    db.get<DbTaskRow>(
      `SELECT task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created, current_version_id
       FROM Tasks WHERE task_id = ?`,
      [taskId],
      async (err, taskRow) => {
        if (err) {
          console.error('Error fetching task:', err)
          return reject(err)
        }
        if (!taskRow) {
          return resolve(null)
        }

        let currentGqlVersion: Version | null = null
        if (taskRow.current_version_id) {
          // Fetch the current version details
          const versionRow = await new Promise<DbVersionRow | null>(
            (res, rej) => {
              db.get<DbVersionRow>(
                `SELECT * FROM Versions WHERE version_id = ?`,
                [taskRow.current_version_id],
                (vErr, vRow) => {
                  if (vErr) rej(vErr)
                  else res(vRow || null)
                },
              )
            },
          )

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
        resolve(gqlTask)
      },
    )
  })
}

export const getActionDetails = async (
  _parent: unknown,
  args: QueryGetActionDetailsArgs,
): Promise<Action | null> => {
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
    const task = await getTask(null, { taskId: actionId })
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

export const listRevisionsForTask = async (
  _parent: unknown,
  args: { taskId: TraceId } & PaginationArgs,
): Promise<WorkflowRevisionConnection> => {
  const { taskId } = args
  const db = getDB()
  const limit = args.first || 10
  const cursor = args.after ? decodeCursor(args.after) : null

  return new Promise<WorkflowRevisionConnection>((resolve, reject) => {
    let whereClause = 'WHERE task_id = ? AND version_type_tag = \'REVISION\''
    const params: any[] = [taskId]

    if (cursor) {
      whereClause += ' AND version_id > ?'
      params.push(cursor)
    }

    db.all<DbVersionRow>(
      `SELECT * FROM Versions ${whereClause} ORDER BY timestamp_created DESC LIMIT ?`,
      [...params, limit + 1],
      async (err, revisionVersionRows) => {
        if (err) {
          console.error(
            `Error fetching revision versions for taskId ${taskId}:`,
            err,
          )
          return reject(err)
        }

        const hasNextPage = (revisionVersionRows || []).length > limit
        const versionRows = hasNextPage
          ? (revisionVersionRows || []).slice(0, limit)
          : revisionVersionRows || []

        try {
          const workflowRevisions = await Promise.all(
            versionRows.map(async (revisionVersionRow) => {
              const revisionId = revisionVersionRow.version_id as TraceId

              const nodeRows = await new Promise<
                WorkflowRevisionNodeStateRowV12[]
              >((res, rej) => {
                db.all<WorkflowRevisionNodeStateRowV12>(
                  `SELECT workflow_revision_id, node_id_in_workflow, context_asset_hash, required_task_id, last_used_version_id, last_inputs_hash, meta_asset_hash, dependency_status, runtime_status, error_message FROM WorkflowRevisionNodeStates WHERE workflow_revision_id = ?`,
                  [revisionId],
                  (nodeErr, nr) => {
                    if (nodeErr) rej(nodeErr)
                    else res(nr || [])
                  },
                )
              })

              const nodes: WorkflowRevisionNodeState[] = await Promise.all(
                nodeRows.map(async (nodeRow) => {
                  let lastUsedVersion: Version | null = null
                  const versionId = nodeRow.last_used_version_id

                  if (versionId) {
                    const version = await new Promise<DbVersionRow | null>(
                      (res, rej) => {
                        db.get<DbVersionRow>(
                          `SELECT * FROM Versions WHERE version_id = ?`,
                          [versionId],
                          (ovErr, ovRow) => {
                            if (ovErr) rej(ovErr)
                            else res(ovRow || null)
                          },
                        )
                      },
                    )
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
                }),
              )

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
            }),
          )

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

          resolve({
            edges,
            pageInfo,
          })
        }
        catch (error) {
          reject(error)
        }
      },
    )
  })
}

export const getRevision = async (
  _parent: unknown,
  args: { versionId: TraceId },
): Promise<WorkflowRevision | null> => {
  const { versionId } = args

  // The versionId should be a REVISION version ID, which corresponds to a WorkflowRevision
  // We can reuse the existing getWorkflowRevision function
  return getWorkflowRevision(null, { revisionId: versionId })
}

export const findProcessableRevisions = async (
  _parent: unknown,
  args: PaginationArgs,
): Promise<WorkflowRevisionConnection> => {
  const limit = args.first || 10
  const cursor = args.after ? decodeCursor(args.after) : null
  const db = getDB()

  return new Promise<WorkflowRevisionConnection>((resolve, reject) => {
    let baseQuery = `
      SELECT DISTINCT wrns.workflow_revision_id, MIN(v.timestamp_created) as min_created_at
      FROM WorkflowRevisionNodeStates wrns
      JOIN Versions v ON wrns.workflow_revision_id = v.version_id AND v.version_type_tag = 'REVISION'
      WHERE wrns.runtime_status = 'PendingPlayerInput' OR wrns.runtime_status = 'Idle'
    `

    const params: any[] = []
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

    db.all<{ workflow_revision_id: string, min_created_at: string }>(
      baseQuery,
      params,
      async (err, distinctRevisionIdRows) => {
        if (err) {
          console.error(
            'Error fetching distinct processable revisionIds:',
            err,
          )
          return reject(err)
        }

        const hasNextPage = (distinctRevisionIdRows || []).length > limit
        const revisionIdRows = hasNextPage
          ? (distinctRevisionIdRows || []).slice(0, limit)
          : distinctRevisionIdRows || []

        try {
          const workflowRevisions: WorkflowRevision[] = []
          for (const revisionIdRow of revisionIdRows) {
            const revisionId = revisionIdRow.workflow_revision_id as TraceId
            const workflowRevision = await getWorkflowRevision(null, {
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

          resolve({
            edges,
            pageInfo,
          })
        }
        catch (error) {
          reject(error)
        }
      },
    )
  })
}

// Add new paginated functions
export const listTasksByAction = async (
  _parent: unknown,
  args: { actionId: ActionId } & PaginationArgs,
): Promise<TaskConnection> => {
  const db = getDB()

  // Determine pagination direction
  const isReverse = args.last !== null && args.last !== undefined
  const limit = isReverse ? args.last! : args.first || 10

  // Decode both cursors independently to support bounded range queries
  const beforeCursor = args.before ? decodeCursor(args.before) : null
  const afterCursor = args.after ? decodeCursor(args.after) : null

  return new Promise<TaskConnection>((resolve, reject) => {
    let whereClause = 'WHERE action_id = ?'
    const params: any[] = [actionIdToDbFormat(args.actionId)]

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

    db.all<DbTaskRow>(
      `SELECT task_id, scope_id, action_id, inputs_content_hash, name, description, timestamp_created, current_version_id
       FROM Tasks ${whereClause}
       ORDER BY task_id ${orderDirection}
       LIMIT ?`,
      [...params, limit + 1], // Get one extra to check for hasNextPage/hasPreviousPage
      async (err, rows) => {
        if (err) {
          console.error('Error fetching tasks by action:', err)
          return reject(err)
        }

        const hasMore = (rows || []).length > limit
        let taskRows = hasMore ? (rows || []).slice(0, limit) : rows || []

        // Reverse results back to normal order if doing reverse pagination
        // Per Relay spec: "the edge closest to cursor must come last" for before: cursor
        if (isReverse) {
          taskRows = taskRows.reverse()
        }

        try {
          const tasks = await Promise.all(
            taskRows.map(async (taskRow) => {
              let currentGqlVersion: Version | null = null
              if (taskRow.current_version_id) {
                const versionRow = await new Promise<DbVersionRow | null>(
                  (res, rej) => {
                    db.get<DbVersionRow>(
                      `SELECT * FROM Versions WHERE version_id = ?`,
                      [taskRow.current_version_id],
                      (vErr, vRow) => {
                        if (vErr) rej(vErr)
                        else res(vRow || null)
                      },
                    )
                  },
                )
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
            }),
          )

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

          resolve({
            edges,
            pageInfo,
          })
        }
        catch (error) {
          reject(error)
        }
      },
    )
  })
}

export const listActions = async (
  _parent: unknown,
  args: PaginationArgs,
): Promise<ActionConnection> => {
  const db = getDB()

  // For simplicity, we'll implement forward pagination only
  const limit = args.first === 0 ? 0 : args.first || 10 // Handle zero explicitly
  const cursor = args.after ? decodeCursor(args.after) : null

  // Fetch user-defined actions from database
  const userDefinedActions: Action[] = await new Promise((res, rej) => {
    db.all<DbTaskRow>(
      `SELECT task_id, name, description, action_id, inputs_content_hash, timestamp_created, current_version_id
          FROM Tasks WHERE action_id = ?
          ORDER BY task_id ASC`,
      [actionIdToDbFormat(SYSTEM_ACTIONS.CORE_DEFINE_ACTION)],
      async (err, rows) => {
        if (err) return rej(err)

        const actions = await Promise.all(
          (rows || []).map(async (taskRow) => {
            let currentGqlVersion: Version | null = null
            if (taskRow.current_version_id) {
              const versionRow = await new Promise<DbVersionRow | null>(
                (vRes, vRej) => {
                  db.get<DbVersionRow>(
                    `SELECT * FROM Versions WHERE version_id = ?`,
                    [taskRow.current_version_id],
                    (vErr, vRow) => {
                      if (vErr) vRej(vErr)
                      else vRes(vRow || null)
                    },
                  )
                },
              )
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
          }),
        )
        res(actions)
      },
    )
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
export const findRunnableTasks = async (
  _parent: unknown,
  args: {
    actionId?: ActionId | null
    first?: number | null
    after?: string | null
    last?: number | null
    before?: string | null
  },
): Promise<TaskExecutionStateConnection> => {
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

  return new Promise<TaskExecutionStateConnection>((resolve, reject) => {
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
    const params: any[] = [currentTime]

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

    db.all<TaskExecutionStateRow>(query, params, (err, taskRows) => {
      if (err) {
        console.error('Error fetching runnable tasks:', err)
        return reject(err)
      }

      const hasMore = (taskRows || []).length > limit
      let resultRows = hasMore
        ? (taskRows || []).slice(0, limit)
        : taskRows || []

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

      resolve({
        edges,
        pageInfo,
      })
    })
  })
}

export const getWorkflowRevision = async (
  _parent: unknown,
  args: { revisionId: TraceId },
): Promise<WorkflowRevision | null> => {
  const { revisionId } = args
  const db = getDB()

  return new Promise<WorkflowRevision | null>((resolve, reject) => {
    // 1. Fetch the revision Version record
    db.get<DbVersionRow>( // Use DbVersionRow
      `SELECT * FROM Versions WHERE version_id = ? AND version_type_tag = 'REVISION'`, // Use version_id and version_type_tag
      [revisionId],
      async (err, versionRow) => {
        if (err) {
          console.error(
            `Error fetching revision version for revisionId ${revisionId}:`,
            err,
          )
          return reject(err)
        }
        if (!versionRow) {
          console.log(`No revision version found for revisionId ${revisionId}`)
          return resolve(null)
        }

        // 2. Fetch related WorkflowRevisionNodeStates
        db.all<WorkflowRevisionNodeStateRow>(
          `SELECT workflow_revision_id, node_id_in_workflow, context_asset_hash, required_task_id, last_used_version_id, last_inputs_hash, meta_asset_hash, dependency_status, runtime_status, error_message FROM WorkflowRevisionNodeStates WHERE workflow_revision_id = ?`,
          [revisionId],
          async (nodeErr, nodeRows) => {
            if (nodeErr) {
              console.error(
                `Error fetching node states for revisionId ${revisionId}:`,
                nodeErr,
              )
              return reject(nodeErr)
            }

            const nodes: WorkflowRevisionNodeState[] = await Promise.all(
              (nodeRows || []).map(async (nodeRow) => {
                let lastUsedVersion: Version | null = null
                const versionId = nodeRow.last_used_version_id

                if (versionId) {
                  const version = await new Promise<DbVersionRow | null>(
                    (res, rej) => {
                      db.get<DbVersionRow>(
                        `SELECT * FROM Versions WHERE version_id = ?`,
                        [versionId],
                        (ovErr, ovRow) => {
                          if (ovErr) rej(ovErr)
                          else res(ovRow || null)
                        },
                      )
                    },
                  )
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
              }),
            )

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
            resolve(workflowRevision)
          },
        )
      },
    )
  })
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
export const getWorkflowRevisionNodeState = async (
  _parent: unknown,
  args: QueryGetWorkflowRevisionNodeStateArgs,
): Promise<WorkflowRevisionNodeState | null> => {
  const { workflowRevisionId, nodeIdInWorkflow, contextAssetHash } = args
  const db = getDB()

  return new Promise<WorkflowRevisionNodeState | null>((resolve, reject) => {
    db.get<WorkflowRevisionNodeStateRowV12>(
      `SELECT * FROM WorkflowRevisionNodeStates 
       WHERE workflow_revision_id = ? AND node_id_in_workflow = ? AND context_asset_hash = ?`,
      [workflowRevisionId, nodeIdInWorkflow, contextAssetHash],
      async (err, row) => {
        if (err) {
          console.error(
            `Error fetching node state for ${workflowRevisionId}/${nodeIdInWorkflow}:`,
            err,
          )
          return reject(err)
        }
        if (!row) {
          return resolve(null)
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

        resolve(nodeState)
      },
    )
  })
}

/**
 * List workflow revision node states by task ID (reverse lookup)
 */
export const listWorkflowRevisionNodeStatesByTask = async (
  _parent: unknown,
  args: QueryListWorkflowRevisionNodeStatesByTaskArgs,
): Promise<WorkflowRevisionNodeStateConnection> => {
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

  return new Promise<WorkflowRevisionNodeStateConnection>((resolve, reject) => {
    // Build WHERE clause with optional workflow_revision_id filter
    let query = `SELECT * FROM WorkflowRevisionNodeStates WHERE required_task_id = ?`
    const params: any[] = [taskId]

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

    db.all<WorkflowRevisionNodeStateRowV12>(
      query,
      params,
      async (err, rows) => {
        if (err) {
          console.error(`Error fetching node states by task ${taskId}:`, err)
          return reject(err)
        }

        const nodeStates = rows || []
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

        resolve({
          edges,
          pageInfo,
        })
      },
    )
  })
}

/**
 * List active workflow revision node states by task ID (reverse lookup)
 * Only returns node states from the latest (active) revision version of each workflow instance
 */
export const listActiveWorkflowRevisionNodeStatesByTask = async (
  _parent: unknown,
  args: {
    taskId: TraceId
    first?: number | null
    after?: string | null
    last?: number | null
    before?: string | null
  },
): Promise<WorkflowRevisionNodeStateConnection> => {
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

  return new Promise<WorkflowRevisionNodeStateConnection>((resolve, reject) => {
    // Build query that finds only active (latest revision) workflow revision node states
    // Strategy: Use O(1) active_revision_id pointer from Tasks table
    // This replaces expensive NOT EXISTS subquery with simple JOIN
    let query = `
      SELECT wrns.*
      FROM WorkflowRevisionNodeStates wrns
      INNER JOIN Tasks t ON wrns.workflow_revision_id = t.active_revision_id
      WHERE wrns.required_task_id = ?
    `

    const params: any[] = [taskId]

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

    db.all<WorkflowRevisionNodeStateRowV12>(
      query,
      params,
      async (err, rows) => {
        if (err) {
          console.error(
            `Error fetching active node states by task ${taskId}:`,
            err,
          )
          return reject(err)
        }

        const nodeStates = rows || []
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

        resolve({
          edges,
          pageInfo,
        })
      },
    )
  })
}
/**
 * Get a specific node state from a workflow revision
 * Used by pipeline-runner to check if a node has already been executed
 */
export const getNodeState = async (
  _parent: unknown,
  args: {
    workflowRevisionId: TraceId
    nodeId: string
    contextAssetHash: AssetId
  },
): Promise<WorkflowRevisionNodeState | null> => {
  const { workflowRevisionId, nodeId, contextAssetHash } = args
  const db = getDB()

  return new Promise<WorkflowRevisionNodeState | null>((resolve, reject) => {
    db.get<WorkflowRevisionNodeStateRowV12>(
      `SELECT * FROM WorkflowRevisionNodeStates
       WHERE workflow_revision_id = ?
         AND node_id_in_workflow = ?
         AND context_asset_hash = ?`,
      [workflowRevisionId, nodeId, contextAssetHash],
      (err, row) => {
        if (err) {
          console.error('Error fetching node state:', err)
          return reject(err)
        }

        if (!row) {
          return resolve(null)
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

        resolve(nodeState)
      },
    )
  })
}

/**
 * Get merge accumulator state (for debugging)
 * v14.1 addition for centralized merge node state management
 */
export const getMergeAccumulator = async (
  _parent: unknown,
  args: {
    pipelineId: AssetId
    workflowRevisionId: TraceId
    contextAssetHash: AssetId
    nodeId: string
  },
): Promise<DictAsset | null> => {
  const { pipelineId, workflowRevisionId, contextAssetHash, nodeId } = args
  const db = getDB()

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT accumulator_json FROM PipelineMergeAccumulator
       WHERE pipeline_id = ? AND workflow_revision_id = ? AND context_asset_hash = ? AND node_id = ?`,
      [pipelineId, workflowRevisionId, contextAssetHash, nodeId],
      (err, row: any) => {
        if (err) return reject(err)

        if (!row?.accumulator_json) {
          return resolve(null)
        }

        try {
          const result = decodeFromString(row.accumulator_json) as DictAsset
          resolve(result)
        }
        catch (parseErr) {
          reject(parseErr)
        }
      },
    )
  })
}

/**
 * Get task execution state - used to check if task is in terminal state (SUCCEEDED/FAILED)
 * for redelivery detection in pipeline-runner
 */
export const getTaskExecutionState = async (
  _parent: unknown,
  args: { taskId: TraceId },
): Promise<TaskExecutionState | null> => {
  const { taskId } = args
  const db = getDB()

  return new Promise<TaskExecutionState | null>((resolve, reject) => {
    db.get<{
      task_id: string
      runtime_status: string
      claim_timestamp: number | null
      claim_worker_id: string | null
      claim_ttl_seconds: number | null
    }>(
      `SELECT task_id, runtime_status, claim_timestamp, claim_worker_id, claim_ttl_seconds
       FROM TaskExecutionStates
       WHERE task_id = ?`,
      [taskId],
      (err, row) => {
        if (err) {
          console.error(
            `Error fetching task execution state for ${taskId}:`,
            err,
          )
          return reject(err)
        }

        if (!row) {
          return resolve(null)
        }

        resolve({
          taskId: row.task_id as Scalars['TraceId']['output'],
          runtimeStatus: row.runtime_status as RuntimeStatus,
          claim_timestamp: row.claim_timestamp,
          claim_worker_id: row.claim_worker_id,
          claim_ttl_seconds: row.claim_ttl_seconds,
        })
      },
    )
  })
}

/**
 * Get an interceptor session by session ID
 */
export const getInterceptorSession = async (
  _parent: unknown,
  args: { sessionId: string },
): Promise<{
  sessionId: string
  sessionTaskId: Scalars['TraceId']['output']
  computationTaskId: Scalars['TraceId']['output']
  currentRevisionId: Scalars['TraceId']['output']
  referenceContextJson: string | null
  toolCallMappingJson: string | null
  createdAt: number
  lastActivity: number
} | null> => {
  const { sessionId } = args
  const db = getDB()

  return new Promise((resolve, reject) => {
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
      `SELECT session_id, session_task_id, computation_task_id, current_revision_id,
              reference_context_json, tool_call_mapping_json, created_at, last_activity
       FROM InterceptorSessions
       WHERE session_id = ?`,
      [sessionId],
      (err, row) => {
        if (err) {
          console.error(`Error fetching interceptor session ${sessionId}:`, err)
          return reject(err)
        }

        if (!row) {
          return resolve(null)
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
  })
}
