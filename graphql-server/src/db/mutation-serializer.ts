// Copyright (c) 2026 Wuji Labs Inc
/**
 * Transaction helpers for better-sqlite3
 *
 * With better-sqlite3's synchronous API, transactions run atomically in a single
 * event loop tick. No interleaving is possible, so the old MutationSerializer
 * (promise-chain FIFO queue) is no longer needed.
 *
 * ## API
 * - `withTransaction(name, fn)` — run fn inside BEGIN/COMMIT/ROLLBACK
 * - `serializeMutation(name, fn)` — run fn directly (no-op wrapper, kept for compatibility)
 */

import type { Database } from 'better-sqlite3'

import { getDB } from '../db.js'

/**
 * Run a function inside a transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
 * Automatically rolls back on exception.
 */
export function withTransaction<T>(
  operationName: string,
  fn: (db: Database) => T,
): T {
  const db = getDB()
  const txFn = db.transaction(() => fn(db))
  return txFn()
}

/**
 * No-op wrapper kept for callers that used serializeMutation without a transaction.
 * With synchronous better-sqlite3, serialization is inherent.
 */
export function serializeMutation<T>(
  _operationName: string,
  fn: () => T,
): T {
  return fn()
}
