// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Public types for @playtiss/core/channel.
//
// Protocol mapping (collaboration-protocol L2 + L3 + L4):
//
//   - L2.2 Immutable Value — `BlobRef`, content-addressed bytes.
//   - L2.3 Reference — events table is the binding-history substrate
//     for the channel's per-topic / per-session references.
//   - L2.4 Resolution — `submit()` is the L4 verb. Each Task's apply()
//     returns an `Outcome` (accept / exception). All outcomes are
//     recorded — exceptions get a `projection.exception` event so the
//     L1.10 Explicit Discarding invariant holds.
//   - L3.5 Task — `apply(Action, Input)` produces a content-hashed
//     `TaskId`. Same (action, input) → same TaskId across processes.
//   - L3.6 Revision — Tasks own their Revision streams. Channel doesn't
//     model stream shape; Tasks have direct DB access for projection
//     writes.
//
// What this package does NOT do (v0.3 scope):
//   - subscribe() AsyncIterable cursor reads — v0.4 when arianna lands
//   - propose / resolve / setResolver beyond trivial auto-accept — v0.4
//   - ref(name) compositional Reference primitive — v0.4
//   - save() / mount() / exit() L4 verbs — v0.4 if needed
//   - Async projector apply() — Tasks' apply() stays sync for v0.3
//
// Kafka analogy: the channel is the broker (writes the log + storage
// primitives + Task registry); Tasks are consumers (own their apply(),
// their offset, their projection writes). retcon's `ProjectorRunner`
// pattern is one in-process synchronous-dispatch convention on top of
// the channel; future consumers may use a different runner.

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'

import type { AssetId } from '../asset-id.js'
import type { StorageProvider } from '../asset-store/index.js'
import type { TraceId } from '../trace-id.js'

/** Re-exported for downstream callers that don't import better-sqlite3 directly. */
export type Database = BetterSqliteDatabase

/**
 * One event in the substrate. The event log is append-only, content-immutable
 * once written. `id` is a monotonic {@link TraceId}; `topic` is an opaque
 * string the channel doesn't interpret beyond using it for Task subscription
 * filtering; `payload` is application-shaped (the channel JSON-encodes it
 * for storage and decodes on read).
 */
export interface Event<Payload = unknown> {
  id: TraceId
  topic: string
  payload: Payload
  sessionId: string | null
  createdAt: number
}

/** A content-addressed blob the channel must store alongside an event row. */
export interface BlobRef {
  cid: string
  bytes: Uint8Array
}

/**
 * Opaque action identifier for v0.3. Full L3.4 form (Action-as-Task) deferred.
 * Convention: namespace.dotted.name, e.g. `"playtiss.proxy.project-revisions"`.
 */
export type ActionId = string

/**
 * Content-hashed Task identity. Computed via {@link applyTask} as
 * `computeHash({ action, input })`. Same logical inputs produce the same
 * TaskId across processes / machines (L2.1 referential transparency).
 *
 * Reused as {@link AssetId} since it's the same shape — a CIDv1 string.
 * Future v1.0 may brand it separately if Task identities need a distinct
 * namespace.
 */
export type TaskId = AssetId

/**
 * Runtime-discriminated reference to another Task in this channel. Embed
 * inside a {@link TaskInput} dict to declare a topological dependency:
 *
 * ```ts
 * const input: TaskInput = {
 *   topics: ['proxy.request_received'],
 *   session_index: { kind: 'task_ref', id: sessionsTaskId },
 * }
 * ```
 *
 * The runner walks Input recursively and harvests every `kind === 'task_ref'`
 * value. Order of registration becomes irrelevant; dispatch follows
 * dependency order.
 *
 * The shape `{ kind, id }` (vs. a compile-time-only branded TaskId) is
 * deliberately runtime-visible so it survives JSON serialization / hashing —
 * the L2.1 Naming Grammar's compositional structure stays explicit in data.
 */
export interface TaskRef {
  readonly kind: 'task_ref'
  readonly id: TaskId
}

/** Type guard for {@link TaskRef} discrimination at runtime. */
export function isTaskRef(value: unknown): value is TaskRef {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'task_ref'
    && typeof (value as { id?: unknown }).id === 'string'
  )
}

/** Construct a {@link TaskRef} for embedding in a Task's Input dict. */
export function taskRef(id: TaskId): TaskRef {
  return { kind: 'task_ref', id }
}

/**
 * The `input` half of L3.5's `apply(Action, Input)`. Free-form dict keyed
 * by semantic field name (e.g. `topics`, `session_index`, `upstream`). Any
 * value of shape {@link TaskRef} declares a topological dependency.
 *
 * `topics` is a special-cased convention for projection-style Tasks: the
 * runner uses it as the topic-filter for dispatch. Other Tasks (e.g.
 * arianna's eventual sync archive) may omit `topics` entirely.
 */
export interface TaskInput {
  readonly topics?: ReadonlyArray<string>
  readonly [key: string]: unknown
}

/**
 * A registered Task. Carries its content-hashed identity, its (action, input)
 * pair (the protocol identity primitive), and its `apply()` function — the
 * resolver that processes events. Channel does not call `apply()`; the
 * consumer's runner does.
 */
export interface Task {
  readonly id: TaskId
  readonly action: ActionId
  readonly input: TaskInput
  apply(event: Event, tx: Database): void
}

/**
 * Per-Task key/value metadata. Backed by the channel's `task_metadata` table.
 *
 * Operations are synchronous; callers running inside a transaction see the
 * writes atomically with their other tx work.
 */
export interface KV<K extends string = string, V = string> {
  get(key: K): V | null
  set(key: K, value: V): void
  delete(key: K): void
}

/**
 * The protocol L2.4 Resolution outcome produced by a Task's apply() when the
 * Channel dispatches an event. v0.3 ships two baseline sub-states: future
 * channels may extend `Outcome` additively with `reject`, `partial`, `merge`,
 * `defer`, `custom`, etc. — existing consumers ignore unknown `kind` values.
 *
 * `accept` is the trivial-resolution case: apply() ran to completion. Accept
 * outcomes are also implicit in {@link KV} offset advancement, so v0.3 does
 * NOT emit a separate substrate event for them. v0.4 can add
 * `topic: 'projection.accept'` events additively when subscribe()-side
 * consumers need cursor-based read of all outcomes.
 *
 * `exception` is the protocol's "exception sub-state of a Revision" (L3.6.3)
 * — apply() threw before completing. The throw is data, not an error: the
 * Channel catches it, rolls back the projector's SAVEPOINT (its partial
 * writes are discarded), records the exception as a substrate event
 * (`topic: 'projection.exception'`, payload includes the source event id,
 * the task id, and the error message), AND continues dispatching downstream
 * Tasks.
 */
export type Outcome =
  | { kind: 'accept', taskId: TaskId }
  | { kind: 'exception', taskId: TaskId, error: string }

/**
 * Returned from {@link Channel.submit}. Carries the recorded event row and
 * the per-Task Resolution outcomes from the dispatch round.
 *
 * The event ALWAYS lands as long as the Channel itself didn't fail
 * (DB I/O / constraint violation surfaces as Promise rejection). Projector
 * exceptions in `outcomes` do NOT void `event` — they're recorded data per
 * L1.2 (No Errors, only Exceptions).
 *
 * `outcomes` lists ONE entry per Task whose `input.topics` included this
 * event's topic, in dependency-derived dispatch order. Tasks not subscribed
 * to this topic do not appear here.
 */
export interface SubmitResult<P> {
  event: Event<P>
  outcomes: ReadonlyArray<Outcome>
}

/**
 * The Channel interface — substrate primitives (L2) shaped as L4 verbs.
 *
 * v0.3 ships only {@link submit} (and the Task-registration / metadata
 * helpers). Other L4 verbs (save / resolve / subscribe / mount / exit)
 * deferred until a consumer needs them. Adding them later is purely additive.
 */
export interface Channel {
  /**
   * L4 Submit — record an event in the substrate, dispatch to subscribed
   * Tasks, return the per-Task outcomes.
   *
   * Async by shape — local sqlite resolves on the same microtask. The
   * caller doesn't get a usable affordance for parallelism inside the
   * submit (it's atomic per the outer BEGIN IMMEDIATE), but the SHAPE
   * is async so future cross-process channels swap in without breaking
   * callers.
   *
   * The event row lands UNCONDITIONALLY. Projector exceptions do not
   * void the event. They're captured as {@link Outcome} entries in
   * {@link SubmitResult.outcomes} AND recorded as substrate events with
   * topic 'projection.exception' (L1.10 Explicit Discarding).
   *
   * Channel-level failures (DB I/O, constraint violations on the event
   * itself) propagate as Promise rejection — distinct from projector
   * exceptions, which are part of the resolved outcome.
   */
  submit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Promise<SubmitResult<P>>

  /** Content-addressed blob storage. */
  readonly storage: StorageProvider

  /**
   * Register a Task. Idempotent (same TaskId → no-op). Topo-sort is lazy
   * — deferred until first submit() so out-of-order registration works
   * (e.g. register B then A where B has TaskRef(A.id); both must be
   * registered before submit() resolves them).
   */
  registerTask(task: Task): void

  /**
   * Per-Task K/V metadata, backed by the `task_metadata` table.
   *
   * v0.3 callers typically use `events_offset` to track per-Task event-log
   * cursor — the channel bumps this automatically on each accept outcome
   * during submit(). Additional keys are free-form; the channel doesn't
   * interpret them.
   */
  taskMetadata(taskId: TaskId): KV<string, string>

  /**
   * Direct DB handle — Tasks query the events / blobs / task_metadata
   * tables via SQL for catch-up, filtered reads, etc. v0.4 may hide this
   * when subscribe() ships with AsyncIterable cursor semantics.
   */
  readonly db: Database
}

export interface ChannelOptions {
  /**
   * SQLite handle. The caller is responsible for opening the DB and calling
   * {@link migrate} before constructing the Channel — channel.ts does not
   * open or migrate on its own.
   */
  db: Database
  /**
   * Initial Tasks to register at construction. Equivalent to calling
   * {@link Channel.registerTask} once per Task after construction; provided
   * here for ergonomic single-call wiring.
   */
  tasks?: ReadonlyArray<Task>
}
