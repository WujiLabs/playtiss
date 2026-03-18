// Copyright (c) 2026 Wuji Labs Inc
import { LRUCache } from 'lru-cache'
import { type AssetId, type AssetValue } from 'playtiss'
import { load } from 'playtiss/asset-store'
import { getLimiter } from './concurrency-limiter.js'

const assetLoadCache = new LRUCache<AssetId, Promise<AssetValue>>({
  max: 1000,
  ttl: 1000 * 60 * 60,
  updateAgeOnGet: true,
})

export async function loadCached(assetId: AssetId): Promise<AssetValue> {
  const cachedPromise = assetLoadCache.get(assetId)
  if (cachedPromise) {
    const cached = await cachedPromise
    if (cached instanceof Uint8Array) return new Uint8Array(cached)
    if (typeof cached === 'object' && cached !== null && !Array.isArray(cached)) {
      return { ...(cached as Record<string, AssetValue>) }
    }
    return cached
  }
  const s3LoadLimiter = getLimiter('s3-load')
  const loadPromise = s3LoadLimiter(() => load(assetId)) as Promise<AssetValue>
  assetLoadCache.set(assetId, loadPromise)
  try {
    return await loadPromise
  } catch (error) {
    assetLoadCache.delete(assetId)
    throw error
  }
}
