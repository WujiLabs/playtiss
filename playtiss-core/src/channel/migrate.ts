// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Channel-owned schema migrations.
//
// The channel package owns these tables:
//   - blobs                  — L2.2 immutable value backing
//   - events                 — L2.3 binding-history substrate (event log)
//   - task_metadata          — per-Task K/V (offsets, etc.)
//   - channel_schema_version — channel's migration ledger (separate from
//                              the consumer's own schema_version)
//
// Two separate schema_version tables (per the migration-boundary
// decision recorded in the channel-refactor plan, option Q1=a.1):
// channel owns `channel_schema_version`; the consumer owns whatever
// migration ledger it pleases. The consumer calls `channel.migrate(db)`
// FIRST, then its own migrate(). Each tracks its own version
// independently — channel bumps don't force consumer code changes.

import type { Database } from './types.js'

export const CURRENT_CHANNEL_SCHEMA_VERSION = 1

// Per-version migrations. MIGRATIONS[N] takes a DB at
// channel_schema_version=N and brings it to N+1. v1 is the initial
// cut — no prior versions exist yet. Future bumps add entries here.
const MIGRATIONS: Record<number, (db: Database) => void> = {
  // No migrations yet — v1 is the initial cut.
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS channel_schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic, event_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, event_id);
-- Composite index for "all events of topic X in session Y, in event_id order".
CREATE INDEX IF NOT EXISTS idx_events_session_topic ON events(session_id, topic, event_id);

-- v0.3 NEW: generic per-Task K/V. Replaces the projection_offsets
-- convention from retcon's pre-Step-2 era. The single-key 'events_offset'
-- holds the last_processed_event_id per Task (bumped on every accept
-- outcome during submit()); additional keys are free-form.
CREATE TABLE IF NOT EXISTS task_metadata (
  task_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (task_id, key)
);
`

/**
 * Bring the channel-owned tables in `db` to {@link CURRENT_CHANNEL_SCHEMA_VERSION}.
 *
 * Two paths:
 *
 *   - Fresh DB (no `channel_schema_version` row): create all tables at
 *     the latest schema and stamp `channel_schema_version` = CURRENT.
 *   - Existing DB (channel_schema_version row present): iterate
 *     MIGRATIONS[v] from the stored version up to CURRENT, applying each.
 *     Stamps after each step.
 *
 * The consumer (e.g. retcon) MUST call this before constructing a Channel,
 * AND before its own migrate(). Idempotent: calling twice is a no-op.
 *
 * Does NOT take a backup of the DB — that's the consumer's responsibility
 * (it owns the file path). The consumer's migrate() typically wraps
 * channel.migrate() and adds backup behavior at the top.
 */
export function migrate(db: Database): void {
  // schema_version table must exist before reading from it.
  db.exec(`CREATE TABLE IF NOT EXISTS channel_schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`)

  const row = db
    .prepare('SELECT MAX(version) AS v FROM channel_schema_version')
    .get() as { v: number | null }
  const current = row?.v ?? 0

  if (current > CURRENT_CHANNEL_SCHEMA_VERSION) {
    throw new Error(
      `@playtiss/core/channel: DB channel_schema_version=${current} is newer than `
      + `this package's ${CURRENT_CHANNEL_SCHEMA_VERSION}. Upgrade @playtiss/core.`,
    )
  }

  if (current === 0) {
    // Fresh — create everything at v1 in one go.
    db.exec(SCHEMA_V1)
    db.prepare('INSERT INTO channel_schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_CHANNEL_SCHEMA_VERSION, Date.now())
    return
  }

  // Step from current → CURRENT.
  for (let v = current; v < CURRENT_CHANNEL_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) {
      throw new Error(
        `@playtiss/core/channel: no migration registered for `
        + `channel_schema_version ${v} → ${v + 1}.`,
      )
    }
    step(db)
    db.prepare('INSERT INTO channel_schema_version (version, applied_at) VALUES (?, ?)')
      .run(v + 1, Date.now())
  }
}
