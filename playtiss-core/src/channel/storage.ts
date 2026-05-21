// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// SqliteStorageProvider — channel-owned content-addressed blob backing.
//
// Satisfies @playtiss/core's StorageProvider interface. The `references`
// parameter on saveBuffer is accepted for conformance but not persisted in
// v0.3 — a future GC layer can wire it up via a separate references table.

import type { AssetId } from '../asset-id.js'
import type { AssetReferences, StorageProvider } from '../asset-store/index.js'

import type { Database } from './types.js'

export class SqliteStorageProvider implements StorageProvider {
  private readonly existsStmt
  private readonly fetchStmt
  private readonly saveStmt

  constructor(private readonly db: Database) {
    this.existsStmt = db.prepare('SELECT 1 FROM blobs WHERE cid=?')
    this.fetchStmt = db.prepare('SELECT bytes FROM blobs WHERE cid=?')
    this.saveStmt = db.prepare(
      'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
    )
  }

  async hasBuffer(id: AssetId): Promise<boolean> {
    return this.existsStmt.get(id) !== undefined
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    const row = this.fetchStmt.get(id) as { bytes: Uint8Array } | undefined
    if (!row) throw new Error(`Blob not found: ${id}`)
    return row.bytes
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    _references?: AssetReferences,
  ): Promise<void> {
    this.saveStmt.run(id, buffer, buffer.byteLength, Date.now())
  }
}

// Compile-time conformance witness — breaks the build if SqliteStorageProvider
// drifts away from the StorageProvider contract.
export const _storageProviderConformance: StorageProvider = new Proxy(
  {} as SqliteStorageProvider,
  { get: () => () => { /* noop */ } },
)
