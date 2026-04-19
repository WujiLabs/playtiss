// Copyright (c) 2026 Wuji Labs Inc
//
// Concrete system actions registry for the playtiss SDK.
//
// The `SystemActionId` TYPE (core:${string} prefix pattern) lives in
// @playtiss/core — this file owns the concrete list of built-in system
// actions + their schemas + the runtime helpers to look them up. Third-party
// tools that don't use playtiss's orchestrator opinions do not need this file.

import type { AssetValue } from '@playtiss/core'
import type { ActionId, SystemActionId } from '@playtiss/core'

/** Default scope identifier used by the playtiss SDK when none is supplied. */
export const default_scope_id = 'default'

/**
 * System action definition for built-in actions
 */
export interface SystemAction {
  id: SystemActionId
  name: string
  description: string
  input_schema: AssetValue
  output_schema: AssetValue
}

/**
 * Registry of all built-in system actions (lazy-loaded)
 */
let _systemActionIds: {
  CORE_DEFINE_ACTION: SystemActionId
  CORE_ORCHESTRATE_UPDATE_STALE: SystemActionId
} | null = null

function getSystemActionIds() {
  if (!_systemActionIds) {
    _systemActionIds = {
      CORE_DEFINE_ACTION: 'core:define_action' as SystemActionId,
      CORE_ORCHESTRATE_UPDATE_STALE: 'core:orchestrate_update_stale' as SystemActionId,
    }
  }
  return _systemActionIds
}

export const SYSTEM_ACTIONS = {
  get CORE_DEFINE_ACTION() {
    return getSystemActionIds().CORE_DEFINE_ACTION
  },
  get CORE_ORCHESTRATE_UPDATE_STALE() {
    return getSystemActionIds().CORE_ORCHESTRATE_UPDATE_STALE
  },
} as const

/**
 * Built-in system action definitions (lazy-loaded)
 */
let _systemActionDefinitions: Record<SystemActionId, SystemAction> | null = null

export function getSystemActionDefinitions(): Record<SystemActionId, SystemAction> {
  if (!_systemActionDefinitions) {
    _systemActionDefinitions = {
      [SYSTEM_ACTIONS.CORE_DEFINE_ACTION]: {
        id: SYSTEM_ACTIONS.CORE_DEFINE_ACTION,
        name: 'core:define_action',
        description: 'Creates a new action definition that can be used to build workflows',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['name', 'description'],
        },
        output_schema: {
          type: 'object',
          properties: {
            actionId: { type: 'string', format: 'ActionId' },
          },
          required: ['actionId'],
        },
      },

      [SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE]: {
        id: SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE,
        name: 'core:orchestrate_update_stale',
        description: 'Command task to orchestrate updating all stale nodes in a workflow',
        input_schema: {
          type: 'object',
          properties: {
            wiTaskId: { type: 'string', format: 'TraceId' },
            staleNodeIds: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
            },
          },
          required: ['wiTaskId'],
        },
        output_schema: {
          type: 'object',
          properties: {
            newSnapshotId: { type: 'string', format: 'TraceId' },
            wiTaskId: { type: 'string', format: 'TraceId' },
            staleNodeIds: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
            },
            parentSnapshotId: { type: 'string', format: 'TraceId' },
          },
          required: ['newSnapshotId', 'wiTaskId', 'parentSnapshotId'],
        },
      },
    }
  }
  return _systemActionDefinitions
}

/**
 * Gets a system action definition by ActionId
 */
export function getSystemAction(actionId: SystemActionId): SystemAction | null {
  return getSystemActionDefinitions()[actionId] || null
}

/**
 * Converts an ActionId to a database-storable format.
 * Trivial cast kept as a named function for call-site readability.
 */
export function actionIdToDbFormat(actionId: ActionId): string {
  return actionId as string
}

/**
 * Converts a database-stored action ID back to ActionId type.
 * Trivial cast kept as a named function for call-site readability.
 */
export function dbFormatToActionId(dbValue: string): ActionId {
  return dbValue as ActionId
}
