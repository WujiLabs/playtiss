// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Relationship generics for the Collaboration Protocol.
//
// This module defines HOW Tasks, Revisions, and Actions relate to each other —
// not their concrete field layouts. Consumers (the playtiss SDK, or a third-
// party harness) provide their own concrete types that satisfy these generic
// constraints, and TypeScript verifies conformance at compile time.
//
// Example conformance:
//
//   import type { TaskLike } from '@playtiss/core/task'
//   type MyTask = TaskLike<MyTaskId, MyActionId, MyInput, MyRevisionId> & {
//     // your own extra fields
//   }
//
// With relationship generics, core ships zero concrete field combinations —
// the interop contract lives in the type system, the data model choices
// live with each implementation.

import type { AssetId } from './asset-id.js'
import type { AssetValue, DictAsset } from './asset-value.js'
import type { TraceId } from './trace-id.js'

// ----------------------------------------------------------------------------
// Branded identifier types
// ----------------------------------------------------------------------------

export type RevisionId = TraceId & { readonly __sub_brand: 'RevisionId' }
export type TaskId = TraceId & { readonly __sub_brand: 'TaskId' }
export type UserActionId = TaskId & { readonly __sub_sub_brand: 'UserActionId' }

/**
 * Namespaced action identifier — a string prefixed by a tool-specific namespace
 * followed by a colon. This is the canonical pattern for third-party harnesses
 * naming their own actions without colliding:
 *
 *   type SystemActionId = NamespacedActionId<'core'>   // `core:${string}`
 *   type ProxyActionId  = NamespacedActionId<'proxy'>  // `proxy:${string}`
 *   type CursorActionId = NamespacedActionId<'cursor'> // `cursor:${string}`
 */
export type NamespacedActionId<Prefix extends string> = `${Prefix}:${string}`

/**
 * Reserved namespace for playtiss's built-in actions (core:define_action,
 * core:orchestrate_update_stale, etc.). The concrete registry lives in the
 * SDK; core ships only the type.
 */
export type SystemActionId = NamespacedActionId<'core'>

export type ActionId = UserActionId | SystemActionId

/**
 * Actor identifier — an implementation-defined namespace that groups related
 * tasks. Semantics (multi-tenant, per-project, single-actor, etc.) are up to
 * the implementer.
 */
export type ActorId = string

// ----------------------------------------------------------------------------
// Inline-or-link primitive
// ----------------------------------------------------------------------------

/**
 * A value that may be provided inline OR referenced by CID.
 * ValueOrLink<T> = T | AssetId.
 */
export type ValueOrLink<T> = T | AssetId

// ----------------------------------------------------------------------------
// Relationship generics
// ----------------------------------------------------------------------------

/**
 * Structural minimum of a Task in the Collaboration Protocol.
 *
 * A Task is the unit "action + input" — a named operation that can be
 * executed to produce a Revision. Any concrete Task definition must at
 * minimum identify itself, name an action, carry its direct inputs, and
 * point to a current revision.
 *
 * SDK / third-party tools extend this with their own concrete types:
 *
 *   type ConcreteTask = TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId> & {
 *     scope_id: ActorId
 *     name: string
 *     description: string
 *     created_at: number
 *     // ... any other fields they need
 *   }
 */
export interface TaskLike<
  TId,
  TActionId,
  TInput,
  TRevisionId,
> {
  id: TId
  action_id: TActionId
  direct_inputs: TInput
  current_version_id: TRevisionId
}

/**
 * Structural minimum of a Revision in the Collaboration Protocol.
 *
 * A Revision is a point-in-time record produced by (or associated with) a
 * Task. Revisions form the parentage chain that makes fork/replay and
 * Fresh/Stale propagation meaningful.
 */
export interface RevisionLike<
  TRevisionId,
  TTaskId,
  TAsset,
> {
  id: TRevisionId
  task_id: TTaskId
  asset: TAsset | null
  parent_version_id: TRevisionId | null
}

/**
 * Structural minimum of an Action — a Task used as the named operation of
 * another Task. Every Action declares its I/O schemas so consumers can
 * validate inputs and outputs.
 *
 * ActionLike extends a consumer's concrete TaskLike-satisfying type,
 * reusing whatever extra fields that type already carries (scope, naming,
 * description, timestamps, etc.) and layering the I/O schemas on top.
 */
export interface ActionLike<
  T extends TaskLike<unknown, unknown, unknown, unknown>,
  TSchema = AssetValue,
> {
  task: T
  input_schema: TSchema
  output_schema: TSchema
}

// ----------------------------------------------------------------------------
// Type guards
// ----------------------------------------------------------------------------

/**
 * Checks if an ActionId corresponds to a playtiss built-in system action.
 * Keep in mind: the type guard only checks the `core:` prefix convention.
 * The concrete list of valid system actions lives in the SDK, not here.
 */
export function isSystemAction(actionId: unknown): actionId is SystemActionId {
  return typeof actionId === 'string' && actionId.startsWith('core:')
}

// ----------------------------------------------------------------------------
// Convenience helpers
// ----------------------------------------------------------------------------

/**
 * Concrete form of TaskLike parameterized by Playtiss's default primitive
 * choices (TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId).
 *
 * Use this when you want a ready-made Task shape satisfying the protocol.
 * Consumers who need different primitives (e.g., a distinct AssetId type
 * or a streaming input) should instantiate TaskLike directly.
 */
export type DefaultTask = TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId>

/**
 * Concrete form of RevisionLike parameterized by Playtiss's defaults.
 */
export type DefaultRevision = RevisionLike<RevisionId, TaskId, ValueOrLink<DictAsset>>

/**
 * Concrete form of ActionLike parameterized by DefaultTask.
 */
export type DefaultAction = ActionLike<DefaultTask>
