// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId } from '@playtiss/core'
import { store } from 'playtiss/asset-store'

// Cache the default context asset ID to avoid re-computing it
let _defaultContextAssetId: AssetId | null = null

/**
 * Get the default context asset ID for Phase 1.
 * This is the asset ID of an empty object {}, as specified in PRD v9.
 * All WorkflowRevisionNodeStates records in Phase 1 use this same default context.
 */
export async function getDefaultContextAssetId(): Promise<AssetId> {
  if (_defaultContextAssetId === null) {
    // Store an empty object and cache the result
    _defaultContextAssetId = await store({})
    console.log('Created default context asset:', _defaultContextAssetId)
  }
  return _defaultContextAssetId
}

/**
 * Reset the cached default context (primarily for testing)
 */
export function resetDefaultContextCache(): void {
  _defaultContextAssetId = null
}
