// Copyright (c) 2026 Wuji Labs Inc
import fs from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { type Database, open } from 'sqlite'
import sqlite3 from 'sqlite3'
import { type AssetId } from '../../index.js'
import { type UserActionId, type VersionId } from '../../types/playtiss.js'

// Database connection management
// Note: SQLite dependencies are guaranteed to exist when this file is loaded
// because asset-db.ts verifies them before dynamically importing this file
let db: Database | null = null

async function getDatabase(): Promise<Database> {
  if (!db) {
    // Always save to ~/.playtiss/assets.db regardless of storage backend
    const dbDir = path.join(homedir(), '.playtiss')
    await fs.mkdir(dbDir, { recursive: true })
    const dbPath = path.join(dbDir, 'assets.db')

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    })

    // Create tables if they don't exist
    await initializeTables(db)
  }
  return db
}

async function initializeTables(database: Database): Promise<void> {
  // Create Assets table
  await database.exec(`
    CREATE TABLE IF NOT EXISTS Assets (
      asset_content_hash TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT,
      timestamp_created INTEGER NOT NULL
    )
  `)

  // Create AssetReferences table
  await database.exec(`
    CREATE TABLE IF NOT EXISTS AssetReferences (
      parent_asset_hash TEXT NOT NULL,
      child_asset_hash TEXT NOT NULL,
      PRIMARY KEY (parent_asset_hash, child_asset_hash),
      FOREIGN KEY (parent_asset_hash) REFERENCES Assets(asset_content_hash),
      FOREIGN KEY (child_asset_hash) REFERENCES Assets(asset_content_hash)
    )
  `)

  // Create AssetToActionReferences table (v7 addition for future GC support)
  await database.exec(`
    CREATE TABLE IF NOT EXISTS AssetToActionReferences (
      parent_asset_hash TEXT NOT NULL,
      used_action_task_id TEXT NOT NULL,
      PRIMARY KEY (parent_asset_hash, used_action_task_id),
      FOREIGN KEY (parent_asset_hash) REFERENCES Assets(asset_content_hash)
    )
  `)

  // Create AssetToVersionReferences table (v9 addition for Context assets)
  await database.exec(`
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
  const database = await getDatabase()

  await database.run(
    `INSERT OR IGNORE INTO Assets (
      asset_content_hash, 
      size_bytes, 
      mime_type, 
      timestamp_created
    ) VALUES (?, ?, ?, ?)`,
    [assetId, buffer.length, mimeType, Date.now()],
  )
}

export async function saveAssetReferences(
  parentAssetId: AssetId,
  childAssetIds: AssetId[],
): Promise<void> {
  if (childAssetIds.length === 0) return

  const database = await getDatabase()

  // Use a transaction for bulk inserts
  await database.exec('BEGIN TRANSACTION')

  try {
    for (const childAssetId of childAssetIds) {
      await database.run(
        `INSERT OR IGNORE INTO AssetReferences (parent_asset_hash, child_asset_hash) VALUES (?, ?)`,
        [parentAssetId, childAssetId],
      )
    }
    await database.exec('COMMIT')
  }
  catch (error) {
    await database.exec('ROLLBACK')
    throw error
  }
}

export async function hasAssetRecord(assetId: AssetId): Promise<boolean> {
  const database = await getDatabase()
  const result = await database.get(
    'SELECT 1 FROM Assets WHERE asset_content_hash = ?',
    [assetId],
  )
  return result !== undefined
}

// TODO: Implement AssetToActionReferences population logic
// This function should be called when storing workflow definitions that reference user actions
export async function saveAssetToActionReferences(
  parentAssetId: AssetId,
  userActionIds: UserActionId[],
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
  parentAssetId: AssetId,
  versionIds: VersionId[],
): Promise<void> {
  // TODO: Implement this function to populate AssetToVersionReferences table
  // when Context assets are stored that reference version IDs
  console.warn(
    'saveAssetToVersionReferences not yet implemented - deferred for separate planning',
  )
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close()
    db = null
  }
}
