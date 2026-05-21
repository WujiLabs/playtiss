// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// createChannel: the SQLite reference Channel implementation.
//
// PROTOCOL ALIGNMENT:
//
//   1. submit() is async (returns Promise<SubmitResult>) — the L4 verb
//      shape. Local sqlite resolves on the same microtask (effectively
//      sync) but the SHAPE is async so future cross-process channels swap
//      in without breaking callers.
//
//   2. Per-projector SAVEPOINTs. The outer BEGIN IMMEDIATE wraps blobs +
//      event row + per-Task apply() + bookkeeping in one tx (one fsync
//      per submit). Each projector's apply() runs inside its own savepoint.
//      Exceptions roll back the projector's partial writes without voiding
//      the event row or earlier accepted projectors.
//
//   3. Outcomes are recorded. Each projector's accept/exception goes into
//      SubmitResult.outcomes. Exception outcomes are additionally recorded
//      as substrate events (`topic: 'projection.exception'`) per L1.10
//      Explicit Discarding. Accept outcomes stay implicit in
//      `task_metadata`'s `events_offset` advancement.
//
//   4. submit() naming follows L4 verb vocabulary. Reference implementation
//      naming matters; consumers reading the source learn protocol verbs
//      by exposure.

import {
  generateOperationId,
  type TraceId,
  TraceIdGenerator,
} from '../trace-id.js'

import { buildTopicIndex, dispatchOrderForTopic, topoSort } from './projector-runner.js'
import { SqliteStorageProvider } from './storage.js'
import {
  type BlobRef,
  type Channel,
  type ChannelOptions,
  type Event,
  type KV,
  type Outcome,
  type SubmitResult,
  type Task,
  type TaskId,
} from './types.js'

/**
 * Build a SQLite-backed Channel. Tasks dispatched on submit, in dep order,
 * inside an outer BEGIN IMMEDIATE. Per-projector SAVEPOINTs isolate
 * exceptions.
 *
 * The caller is responsible for:
 *   - Opening the DB (better-sqlite3 `Database`).
 *   - Calling {@link migrate} on it BEFORE constructing the Channel.
 *   - Calling its own migrate() AFTER channel.migrate (consumer-owned
 *     tables shouldn't reference channel-owned tables before they exist).
 */
export function createChannel(opts: ChannelOptions): Channel {
  const { db } = opts

  // One TraceIdGenerator per channel ensures monotonic event_id within
  // this process.
  const idGen = new TraceIdGenerator(generateOperationId())

  // Mutable Task registry. Topo-sort is LAZY — deferred until first
  // submit() so registerTask() can be called in any order.
  const registered: Task[] = []
  let dispatchByTopic: ReadonlyMap<string, Task[]> | null = null

  function rebuildDispatch(): void {
    const sorted = topoSort(registered)
    dispatchByTopic = buildTopicIndex(sorted)
  }

  if (opts.tasks) {
    for (const t of opts.tasks) {
      if (!registered.find(r => r.id === t.id)) registered.push(t)
    }
    rebuildDispatch()
  }

  function registerTask(task: Task): void {
    if (registered.find(r => r.id === task.id)) return
    registered.push(task)
    // Invalidate cached dispatch; rebuild lazily on next submit.
    dispatchByTopic = null
  }

  function ensureDispatch(): ReadonlyMap<string, Task[]> {
    if (!dispatchByTopic) rebuildDispatch()
    return dispatchByTopic!
  }

  // Prepared statements — eager at channel construction.
  const insertBlob = db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  )
  const insertEvent = db.prepare(
    'INSERT INTO events (event_id, topic, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  // task_metadata-backed K/V prepared statements. v0.3 uses a single
  // 'events_offset' key per Task (the event-log cursor); other keys are
  // accepted but the channel itself doesn't write them — they're for
  // application use.
  const upsertMetadata = db.prepare(
    'INSERT INTO task_metadata (task_id, key, value) VALUES (?, ?, ?)'
    + ' ON CONFLICT(task_id, key) DO UPDATE SET value = excluded.value',
  )
  const selectMetadata = db.prepare(
    'SELECT value FROM task_metadata WHERE task_id = ? AND key = ?',
  )
  const deleteMetadata = db.prepare(
    'DELETE FROM task_metadata WHERE task_id = ? AND key = ?',
  )

  function submit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Promise<SubmitResult<P>> {
    const topicIndex = ensureDispatch()

    const now = Date.now()
    const event: Event<P> = {
      id: idGen.generate(),
      topic,
      payload,
      sessionId,
      createdAt: now,
    }
    const payloadStr = JSON.stringify(payload)
    const subscribers = dispatchOrderForTopic(topic, topicIndex)
    const outcomes: Outcome[] = []
    // Exception outcomes need to be inserted as substrate events. We collect
    // their (event id, payload) tuples during dispatch and insert AFTER the
    // for-loop completes — but still inside the outer BEGIN IMMEDIATE so
    // they land atomically with the source event.
    const exceptionEvents: Array<{ id: TraceId, payload: string }> = []

    const tx = db.transaction(() => {
      // 1. Blobs first — they're referenced by the event payload's body_cid.
      if (referencedBlobs) {
        for (const blob of referencedBlobs) {
          insertBlob.run(blob.cid, blob.bytes, blob.bytes.byteLength, now)
        }
      }

      // 2. Event row — lands FIRST and UNCONDITIONALLY. Projector exceptions
      // below do NOT void this. (L1.2 / L1.8 / L1.10 / L2.4.)
      insertEvent.run(event.id, event.topic, payloadStr, event.sessionId, event.createdAt)

      // 3. Dispatch to subscribed Tasks in dep order, each in its own
      // SAVEPOINT. Exceptions roll back the projector's partial writes
      // but leave the event row + earlier accepted projectors intact.
      for (let i = 0; i < subscribers.length; i++) {
        const task = subscribers[i]!
        // SAVEPOINT name must be a valid SQL identifier. Use a sequence-tagged
        // prefix + a short slice of the TaskId hash to keep names unique
        // per-dispatch + readable in logs.
        const spName = `sp_${i}_${task.id.slice(-8).replace(/[^a-zA-Z0-9]/g, '_')}`
        db.exec(`SAVEPOINT ${spName}`)
        let applyThrew: unknown
        try {
          task.apply(event, db)
        }
        catch (err) {
          applyThrew = err
        }
        // Branch on apply()'s outcome, NOT inside the try/catch. This keeps
        // the offset-bump and substrate-event insert OUTSIDE the apply()
        // exception trap — those are channel-bookkeeping writes; if they
        // throw, that's a channel-level failure (DB I/O) that propagates
        // as Promise rejection, not a re-classification of the projector
        // as exception-after-it-already-accepted.
        if (applyThrew === undefined) {
          db.exec(`RELEASE ${spName}`)
          outcomes.push({ kind: 'accept', taskId: task.id })
          // Bump the per-Task events_offset — the accept outcome is implicit
          // in this advancement (v0.3 Q1=c; v0.4 may add `projection.accept`
          // substrate events alongside).
          upsertMetadata.run(task.id, 'events_offset', event.id)
        }
        else {
          // Roll back this projector's partial writes to the savepoint.
          // The event row + previously accepted projectors stay.
          db.exec(`ROLLBACK TO ${spName}`)
          // RELEASE after ROLLBACK TO is required to consume the savepoint
          // (otherwise the savepoint stays open and subsequent SAVEPOINTs
          // accumulate). Per SQLite docs.
          db.exec(`RELEASE ${spName}`)
          const errStr = applyThrew instanceof Error ? applyThrew.message : String(applyThrew)
          outcomes.push({ kind: 'exception', taskId: task.id, error: errStr })
          exceptionEvents.push({
            id: idGen.generate(),
            payload: JSON.stringify({
              source_event_id: event.id,
              task_id: task.id,
              error: errStr,
            }),
          })
        }
      }

      // 4. Insert the projection.exception events recorded above. Still
      // inside the outer tx — they land atomically with the source event
      // and the accepted projectors' writes.
      for (const ee of exceptionEvents) {
        insertEvent.run(ee.id, 'projection.exception', ee.payload, event.sessionId, now)
      }
    })

    try {
      tx.immediate()
    }
    catch (err) {
      // Channel-level failure (DB I/O, primary-key violation on event row,
      // etc.). Distinct from projector exceptions — these surface as
      // Promise rejection because there's no Outcome shape for "the
      // channel itself failed."
      return Promise.reject(err)
    }

    return Promise.resolve({ event, outcomes })
  }

  function taskMetadata(taskId: TaskId): KV<string, string> {
    return {
      get(key) {
        const row = selectMetadata.get(taskId, key) as { value: string } | undefined
        return row?.value ?? null
      },
      set(key, value) {
        upsertMetadata.run(taskId, key, value)
      },
      delete(key) {
        deleteMetadata.run(taskId, key)
      },
    }
  }

  // Storage is cheap to construct (just wraps the db); construct once on
  // channel build rather than on every access.
  const storage = new SqliteStorageProvider(db)

  return {
    submit,
    storage,
    registerTask,
    taskMetadata,
    db,
  }
}
