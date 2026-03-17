// Copyright (c) 2026 Wuji Labs Inc
/**
 * Asset Load Cache - Shared LRU cache for asset load() operations
 *
 * Prevents redundant S3 GetObject calls for same assets across workflows
 * Promise deduplication: Merges concurrent identical load requests
 */

import { LRUCache } from 'lru-cache'
import { isCompoundAssetId, type BinaryAssetId, type CompoundAssetId, type DictLazyAsset } from 'playtiss'
import { load } from 'playtiss/asset-store'
import { getLimiter } from './concurrency-limiter.js'

// Global LRU cache for asset load() operations with promise deduplication
// Prevents redundant S3 GetObject calls for same assets across workflows
// Promise deduplication: Merges concurrent identical load requests
const assetLoadCache = new LRUCache<
  CompoundAssetId | BinaryAssetId,
  Promise<DictLazyAsset | Uint8Array>
>({
  max: 1000, // Cache up to 1k assets
  ttl: 1000 * 60 * 60, // 1 hour TTL (assets are immutable)
  updateAgeOnGet: true, // Refresh TTL on access
})

/**
 * Load asset with caching and concurrency limiting
 * TODO: Implement proper deep copying for compound assets. Currently using shallow copy
 * which provides some protection but doesn't prevent mutations of nested objects.
 * Deep copying is challenging because DictLazyAsset contains lazy loader functions
 * that cannot be cloned with structuredClone. A proper solution would need to:
 * 1. Recursively clone the object structure
 * 2. Preserve lazy loader functions by copying them with null loader
 * 3. Handle circular references if any
 */
export async function loadCached(
  assetId: CompoundAssetId,
): Promise<DictLazyAsset>
export async function loadCached(assetId: BinaryAssetId): Promise<Uint8Array>
export async function loadCached(
  assetId: CompoundAssetId | BinaryAssetId,
): Promise<DictLazyAsset | Uint8Array> {
  // Check for in-flight or resolved promise
  const cachedPromise = assetLoadCache.get(assetId)
  if (cachedPromise) {
    const cached = await cachedPromise
    // Shallow copy for basic protection against mutations
    if (cached instanceof Uint8Array) {
      // Binary assets: create new Uint8Array with same underlying buffer
      return new Uint8Array(cached)
    }
    else {
      // Compound assets: shallow copy (TODO: implement deep copy)
      return { ...cached }
    }
  }

  // Create and cache promise
  const s3LoadLimiter = getLimiter('s3-load')
  const loadPromise = s3LoadLimiter(
    async () => {
      if (isCompoundAssetId(assetId)) {
        return await load(assetId)
      }
      else {
        return await load(assetId)
      }
    },
  ) as Promise<DictLazyAsset | Uint8Array>

  assetLoadCache.set(assetId, loadPromise)

  try {
    const asset = await loadPromise

    // Return shallow copy
    if (asset instanceof Uint8Array) {
      return new Uint8Array(asset)
    }
    else if (Array.isArray(asset)) {
      throw new Error('asset is array')
    }
    else {
      return { ...asset }
    }
  }
  catch (error) {
    // Remove failed promise from cache to allow retry
    assetLoadCache.delete(assetId)
    throw error
  }
}
