// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// channel.ts integration tests at the substrate level — no consumer-specific
// projectors involved. Pins the protocol invariants that v3 introduced:
//
//   - L1.2 / L1.8 / L1.10 / L2.4: event row lands even if projector throws.
//   - L1.10: exception outcomes recorded as substrate events.
//   - L3.5: dep-order dispatch from declared TaskRef Input.
//   - Cascade exceptions (downstream Task runs after upstream throws).
//   - Per-projector SAVEPOINT isolation (one throw doesn't roll back
//     accepted siblings' writes).
//
// retcon owns its own channel.test.ts that drives the full projector chain
// through HTTP / MCP / fork lifecycles. This file is the package-level
// substrate test — it should pass without any retcon dependency.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyTask } from '../../channel/apply-task.js'
import { createChannel } from '../../channel/channel.js'
import { CURRENT_CHANNEL_SCHEMA_VERSION, migrate } from '../../channel/migrate.js'
import { type Database as DB, type Task, taskRef } from '../../channel/types.js'

function open(): DB {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function noopApply(): void { /* test stub */ }

describe('channel migrate', () => {
  it('creates the channel-owned tables at v1 on a fresh DB', () => {
    const db = new Database(':memory:')
    migrate(db)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map(r => r.name)
    expect(tables).toContain('blobs')
    expect(tables).toContain('events')
    expect(tables).toContain('task_metadata')
    expect(tables).toContain('channel_schema_version')
    const stamp = db.prepare('SELECT MAX(version) AS v FROM channel_schema_version').get() as { v: number }
    expect(stamp.v).toBe(CURRENT_CHANNEL_SCHEMA_VERSION)
    db.close()
  })

  it('is idempotent — calling twice does not re-stamp', () => {
    const db = new Database(':memory:')
    migrate(db)
    migrate(db)
    const n = (db.prepare('SELECT COUNT(*) AS n FROM channel_schema_version').get() as { n: number }).n
    expect(n).toBe(1)
    db.close()
  })

  it('refuses to run against a newer schema version', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare('INSERT INTO channel_schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_CHANNEL_SCHEMA_VERSION + 100, Date.now())
    expect(() => migrate(db)).toThrow(/newer than/)
    db.close()
  })

  it('is safe to call on a DB that already has events/blobs from a pre-Step-2 retcon', () => {
    // Simulate an existing retcon v7 DB that has blobs and events but no
    // channel_schema_version. The channel.migrate must not throw on the
    // CREATE TABLE IF NOT EXISTS for blobs/events.
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE blobs (cid TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
    db.exec(`CREATE TABLE events (event_id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL)`)
    db.prepare('INSERT INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)')
      .run('legacy-cid', Buffer.from('legacy'), 6, Date.now())
    migrate(db)
    // Legacy row preserved.
    const row = db.prepare('SELECT cid FROM blobs WHERE cid=?').get('legacy-cid')
    expect(row).toBeDefined()
    // task_metadata is now there.
    const tasks = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_metadata'`).get()
    expect(tasks).toBeDefined()
    db.close()
  })
})

describe('createChannel (happy path)', () => {
  let db: DB
  beforeEach(() => {
    db = open()
  })
  afterEach(() => db.close())

  it('submit() writes event row + dispatches Tasks + records accept outcomes', async () => {
    const channel = createChannel({ db })
    const taskId = await applyTask('test.echo', { topics: ['echo'] })
    let saw: unknown
    channel.registerTask({
      id: taskId,
      action: 'test.echo',
      input: { topics: ['echo'] },
      apply: (event) => { saw = event.payload },
    })

    const result = await channel.submit('echo', { hello: 'world' }, 'sess-1')

    expect(result.event.topic).toBe('echo')
    expect(saw).toEqual({ hello: 'world' })
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]).toEqual(expect.objectContaining({ kind: 'accept', taskId }))

    // Per-Task offset advanced via the accept outcome.
    const offset = channel.taskMetadata(taskId).get('events_offset')
    expect(offset).toBe(result.event.id)

    // Event row persisted.
    const evtCount = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE topic='echo'`).get() as { n: number }).n
    expect(evtCount).toBe(1)
  })

  it('TaskRef dependencies enforce dep-order dispatch even with shared topic', async () => {
    const channel = createChannel({ db })
    const callOrder: string[] = []
    const aId = await applyTask('test.a', { topics: ['shared'] })
    const bId = await applyTask('test.b', {
      topics: ['shared'],
      upstream: taskRef(aId),
    })

    // Register in reverse dep order.
    channel.registerTask({
      id: bId, action: 'test.b', input: { topics: ['shared'], upstream: taskRef(aId) },
      apply: () => callOrder.push('b'),
    })
    channel.registerTask({
      id: aId, action: 'test.a', input: { topics: ['shared'] },
      apply: () => callOrder.push('a'),
    })

    await channel.submit('shared', {}, null)
    expect(callOrder).toEqual(['a', 'b'])
  })

  it('registerTask is idempotent on duplicate id', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', { topics: ['x'] })
    const task: Task = { id, action: 'test.action', input: { topics: ['x'] }, apply: noopApply }
    channel.registerTask(task)
    channel.registerTask(task)
    await channel.submit('x', {}, null)
  })

  it('taskMetadata accepts free-form keys (not just events_offset)', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', {})
    const md = channel.taskMetadata(id)
    md.set('custom_key', 'custom_value')
    expect(md.get('custom_key')).toBe('custom_value')
    md.delete('custom_key')
    expect(md.get('custom_key')).toBeNull()
  })

  it('storage is a working StorageProvider', async () => {
    const channel = createChannel({ db })
    const bytes = new TextEncoder().encode('hello')
    const cid = 'bafkreitestcid' as Parameters<typeof channel.storage.saveBuffer>[1]
    await channel.storage.saveBuffer(bytes, cid)
    expect(await channel.storage.hasBuffer(cid)).toBe(true)
    const fetched = await channel.storage.fetchBuffer(cid)
    expect(Array.from(fetched)).toEqual(Array.from(bytes))
  })
})

describe('createChannel — exception outcomes (the L1.2/L1.10 protocol invariants)', () => {
  let db: DB
  beforeEach(() => {
    db = open()
  })
  afterEach(() => db.close())

  it('projector exception does NOT void the event row', async () => {
    const channel = createChannel({ db })
    const taskId = await applyTask('test.exploding', { topics: ['ka.boom'] })
    channel.registerTask({
      id: taskId,
      action: 'test.exploding',
      input: { topics: ['ka.boom'] },
      apply: () => { throw new Error('boom: simulated projector failure') },
    })

    const result = await channel.submit('ka.boom', { detail: 'hi' }, 'sess-exc')

    // Event row landed.
    const evtCount = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE topic='ka.boom'`).get() as { n: number }).n
    expect(evtCount).toBe(1)

    // Outcome recorded as exception.
    expect(result.outcomes).toHaveLength(1)
    const outcome = result.outcomes[0]!
    expect(outcome.kind).toBe('exception')
    if (outcome.kind === 'exception') {
      expect(outcome.taskId).toBe(taskId)
      expect(outcome.error).toContain('boom')
    }
  })

  it('exception outcome records a projection.exception substrate event', async () => {
    const channel = createChannel({ db })
    const taskId = await applyTask('test.boom', { topics: ['t'] })
    channel.registerTask({
      id: taskId, action: 'test.boom', input: { topics: ['t'] },
      apply: () => { throw new Error('exploded') },
    })

    const result = await channel.submit('t', {}, 'sess-rec')

    const excRows = db.prepare(`SELECT payload FROM events WHERE topic='projection.exception'`).all() as Array<{ payload: string }>
    expect(excRows).toHaveLength(1)
    const excPayload = JSON.parse(excRows[0]!.payload) as {
      source_event_id: string
      task_id: string
      error: string
    }
    expect(excPayload.source_event_id).toBe(result.event.id)
    expect(excPayload.task_id).toBe(taskId)
    expect(excPayload.error).toContain('exploded')
  })

  it('exception in one projector does NOT roll back accepted siblings (SAVEPOINT isolation)', async () => {
    const channel = createChannel({ db })
    db.exec(`CREATE TABLE test_markers (id TEXT PRIMARY KEY, value TEXT)`)

    const goodId = await applyTask('test.good', { topics: ['shared.test'] })
    const badId = await applyTask('test.bad', {
      topics: ['shared.test'],
      upstream: taskRef(goodId),
    })

    channel.registerTask({
      id: goodId, action: 'test.good', input: { topics: ['shared.test'] },
      apply: (event) => {
        db.prepare('INSERT INTO test_markers (id, value) VALUES (?, ?)')
          .run(`good-${event.id}`, 'GOOD')
      },
    })
    channel.registerTask({
      id: badId, action: 'test.bad',
      input: { topics: ['shared.test'], upstream: taskRef(goodId) },
      apply: (event) => {
        db.prepare('INSERT INTO test_markers (id, value) VALUES (?, ?)')
          .run(`bad-partial-${event.id}`, 'PARTIAL')
        throw new Error('bad projector failed mid-write')
      },
    })

    const result = await channel.submit('shared.test', {}, 's')

    // Good projector's row landed.
    const goodRow = db.prepare(`SELECT id FROM test_markers WHERE id = ?`).get(`good-${result.event.id}`)
    expect(goodRow).toBeDefined()

    // Bad projector's partial-write was rolled back by the SAVEPOINT.
    const badRow = db.prepare(`SELECT id FROM test_markers WHERE id = ?`).get(`bad-partial-${result.event.id}`)
    expect(badRow).toBeUndefined()

    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes[0]!.kind).toBe('accept')
    expect(result.outcomes[1]!.kind).toBe('exception')
  })

  it('downstream Task still dispatches after upstream throws (cascade exception)', async () => {
    const channel = createChannel({ db })
    const upstreamId = await applyTask('test.upstream', { topics: ['cascade'] })
    const downstreamId = await applyTask('test.downstream', {
      topics: ['cascade'],
      upstream: taskRef(upstreamId),
    })

    let downstreamRan = false
    channel.registerTask({
      id: upstreamId, action: 'test.upstream', input: { topics: ['cascade'] },
      apply: () => { throw new Error('upstream boom') },
    })
    channel.registerTask({
      id: downstreamId, action: 'test.downstream',
      input: { topics: ['cascade'], upstream: taskRef(upstreamId) },
      apply: () => { downstreamRan = true },
    })

    const result = await channel.submit('cascade', {}, 'sess-cascade')

    expect(downstreamRan).toBe(true)
    expect(result.outcomes.find(o => o.taskId === upstreamId)?.kind).toBe('exception')
    expect(result.outcomes.find(o => o.taskId === downstreamId)?.kind).toBe('accept')
  })

  it('lazy topo-sort: registering A after B (where B refs A) works on first submit', async () => {
    const channel = createChannel({ db })
    const aId = await applyTask('test.a', { topics: ['lazy'] })
    const bId = await applyTask('test.b', {
      topics: ['lazy'],
      upstream: taskRef(aId),
    })

    // Register B FIRST — at this point its TaskRef(aId) points at an
    // unregistered Task. If topo-sort ran eagerly, this would throw.
    // Because topo-sort is lazy, registerTask just stashes B and waits.
    channel.registerTask({
      id: bId, action: 'test.b', input: { topics: ['lazy'], upstream: taskRef(aId) },
      apply: noopApply,
    })
    channel.registerTask({
      id: aId, action: 'test.a', input: { topics: ['lazy'] },
      apply: noopApply,
    })
    // First submit triggers topo-sort. Both Tasks now registered → no throw.
    await channel.submit('lazy', {}, null)
  })
})
