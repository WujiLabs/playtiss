// Copyright (c) 2026 Wuji Labs Inc
import type { Database as DatabaseType } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

import { type AssetId } from '../../index.js'
import { type UserActionId, type VersionId } from '../../types/playtiss.js'

// Database connection management
// Note: better-sqlite3 dependency is guaranteed to exist when this file is loaded
// because asset-db.ts verifies it before dynamically importing this file
let db: DatabaseType | null = null

function getDatabase(): DatabaseType {
  if (!db) {
    // Always save to ~/.playtiss/assets.db regardless of storage backend
    const dbDir = path.join(homedir(), '.playtiss')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }
    const dbPath = path.join(dbDir, 'assets.db')

    db = new Database(dbPath)

    // Create tables if they don't exist
    initializeTables(db)
  }
  return db
}

function initializeTables(database: DatabaseType): void {
  // Create Assets table
  database.exec(`
    CREATE TABLE IF NOT EXISTS Assets (
      asset_content_hash TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT,
      timestamp_created INTEGER NOT NULL
    )
  `)

  // Create AssetReferences table
  database.exec(`
    CREATE TABLE IF NOT EXISTS AssetReferences (
      parent_asset_hash TEXT NOT NULL,
      child_asset_hash TEXT NOT NULL,
      PRIMARY KEY (parent_asset_hash, child_asset_hash),
      FOREIGN KEY (parent_asset_hash) REFERENCES Assets(asset_content_hash),
      FOREIGN KEY (child_asset_hash) REFERENCES Assets(asset_content_hash)
    )
  `)

  // Create AssetToActionReferences table (v7 addition for future GC support)
  database.exec(`
    CREATE TABLE IF NOT EXISTS AssetToActionReferences (
      parent_asset_hash TEXT NOT NULL,
      used_action_task_id TEXT NOT NULL,
      PRIMARY KEY (parent_asset_hash, used_action_task_id),
      FOREIGN KEY (parent_asset_hash) REFERENCES Assets(asset_content_hash)
    )
  `)

  // Create AssetToVersionReferences table (v9 addition for Context assets)
  database.exec(`
    CREATE TABLE IF NOT EXISTS AssetToVersionReferences (
      parent_asset_hash TEXT NOT NULL,
      child_version_id TEXT NOT NULL,
      PRIMARY KEY (parent_asset_hash, child_version_id),
      FOREIGN KEY (parent_asset_hash) REFERENCES Assets(asset_content_hash)
    )
  `)
}

// Database functions for asset management
export async function saveAssetRecord(
  assetId: AssetId,
  buffer: Uint8Array,
  mimeType?: string,
): Promise<void> {
  const database = getDatabase()

  database.prepare(
    `INSERT OR IGNORE INTO Assets (
      asset_content_hash,
      size_bytes,
      mime_type,
      timestamp_created
    ) VALUES (?, ?, ?, ?)`,
  ).run(assetId, buffer.length, mimeType, Date.now())
}

export async function saveAssetReferences(
  parentAssetId: AssetId,
  childAssetIds: AssetId[],
): Promise<void> {
  if (childAssetIds.length === 0) return

  const database = getDatabase()

  const insertRef = database.prepare(
    `INSERT OR IGNORE INTO AssetReferences (parent_asset_hash, child_asset_hash) VALUES (?, ?)`,
  )

  const insertAll = database.transaction(() => {
    for (const childAssetId of childAssetIds) {
      insertRef.run(parentAssetId, childAssetId)
    }
  })

  insertAll()
}

export async function hasAssetRecord(assetId: AssetId): Promise<boolean> {
  const database = getDatabase()
  const result = database.prepare(
    'SELECT 1 FROM Assets WHERE asset_content_hash = ?',
  ).get(assetId)
  return result !== undefined
}

// TODO: Implement AssetToActionReferences population logic
// This function should be called when storing workflow definitions that reference user actions
export async function saveAssetToActionReferences(
  _parentAssetId: AssetId,
  _userActionIds: UserActionId[],
): Promise<void> {
  // TODO: Implement this function to populate AssetToActionReferences table
  // when workflow definitions are stored that reference user action IDs
  console.warn(
    'saveAssetToActionReferences not yet implemented - deferred for separate planning',
  )
}

// TODO: Implement AssetToVersionReferences population logic
// This function should be called when storing Context assets that reference versions
export async function saveAssetToVersionReferences(
  _parentAssetId: AssetId,
  _versionIds: VersionId[],
): Promise<void> {
  // TODO: Implement this function to populate AssetToVersionReferences table
  // when Context assets are stored that reference version IDs
  console.warn(
    'saveAssetToVersionReferences not yet implemented - deferred for separate planning',
  )
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    db.close()
    db = null
  }
}
