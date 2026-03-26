// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId } from '../../index.js'
import { type UserActionId, type VersionId } from '../../types/playtiss.js'

// Database implementation cached after first load
let dbImpl: any = null

async function loadSqliteDependencies() {
  try {
    // Just verify better-sqlite3 can be loaded - no need to cache it
    await import('better-sqlite3')
  }
  catch (error: any) {
    throw new Error(
      `SQLite dependency not available: ${error.message}. `
      + `Install with: npm install better-sqlite3`,
    )
  }
}

async function getDbImpl() {
  if (dbImpl) return dbImpl

  try {
    // First, verify SQLite dependencies are available
    await loadSqliteDependencies()

    // Only if SQLite dependencies exist, load the implementation
    // At this point, asset-db-impl.ts can safely use static imports

    // Handle both CJS and ESM environments properly
    try {
      // Try ESM dynamic import first (works in modern environments)
      dbImpl = await import('./asset-db-impl.js')
    }
    catch (importError) {
      // Fallback to require for CJS environments (Node.js, esbuild CJS target)
      if (typeof require !== 'undefined') {
        try {
          dbImpl = require('./asset-db-impl.js')
        }
        catch {
          // Final fallback for test environments - try dist folder
          const path = require('path')
          const distPath = path.resolve(
            process.cwd(),
            'dist/asset-store/local/asset-db-impl.js',
          )
          dbImpl = require(distPath)
        }
      }
      else {
        throw importError
      }
    }
    return dbImpl
  }
  catch (error) {
    throw new Error(
      `Failed to load SQLite database implementation: ${
        error instanceof Error ? error.message : String(error)
      }. This is required for local storage.`,
    )
  }
}

// Export functions that delegate to the database implementation
export async function saveAssetRecord(
  assetId: AssetId,
  buffer: Uint8Array,
  mimeType?: string,
): Promise<void> {
  const impl = await getDbImpl()
  return impl.saveAssetRecord(assetId, buffer, mimeType)
}

export async function saveAssetReferences(
  parentAssetId: AssetId,
  childAssetIds: AssetId[],
): Promise<void> {
  const impl = await getDbImpl()
  return impl.saveAssetReferences(parentAssetId, childAssetIds)
}

export async function hasAssetRecord(assetId: AssetId): Promise<boolean> {
  const impl = await getDbImpl()
  return impl.hasAssetRecord(assetId)
}

export async function saveAssetToActionReferences(
  parentAssetId: AssetId,
  userActionIds: UserActionId[],
): Promise<void> {
  const impl = await getDbImpl()
  return impl.saveAssetToActionReferences(parentAssetId, userActionIds)
}

export async function saveAssetToVersionReferences(
  parentAssetId: AssetId,
  versionIds: VersionId[],
): Promise<void> {
  const impl = await getDbImpl()
  return impl.saveAssetToVersionReferences(parentAssetId, versionIds)
}

export async function closeDatabase(): Promise<void> {
  const impl = await getDbImpl()
  return impl.closeDatabase()
}
