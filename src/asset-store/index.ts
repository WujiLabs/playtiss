// Copyright (c) 2026 Wuji Labs Inc
//
// SDK wrapper around `@playtiss/core`'s parameterized
// store / load / resolve. The core helpers take an explicit
// StorageProvider; this layer resolves the global provider via
// `getStorageProvider()` and forwards. Existing SDK consumers
// (pipeline-runner, cli, typescript-worker, graphql-server) keep
// using the no-arg form unchanged.
//
// New code that doesn't depend on the SDK's global provider should
// import directly from `@playtiss/core` and pass an explicit
// StorageProvider — see core's `asset-store/operations.ts`.

import type { AssetId, AssetValue, DictAsset, ValueOrLink } from '@playtiss/core'
import {
  load as coreLoad,
  resolve as coreResolve,
  store as coreStore,
} from '@playtiss/core'

import { getStorageProvider } from './storage-factory.js'

/**
 * Persist an AssetValue using the globally-registered StorageProvider.
 * Thin wrapper over `@playtiss/core`'s `store()` — see core for full
 * semantics (Merkle CID + inline bytes, dedup via hasBuffer).
 */
export async function store(input: AssetValue): Promise<AssetId> {
  return coreStore(input, await getStorageProvider())
}

/**
 * Load an asset by id using the globally-registered StorageProvider.
 * See `@playtiss/core`'s `load()` — returns AssetValue with AssetLinks
 * inline; pass through `resolve()` to materialize.
 */
export async function load(id: AssetId): Promise<AssetValue> {
  return coreLoad(id, await getStorageProvider())
}

/**
 * Fully materialize a value by recursively resolving all CID links
 * via the globally-registered StorageProvider. Use
 * `resolve(await load(id))` to get the original nested structure
 * back. Thin wrapper over `@playtiss/core`'s `resolve()`.
 */
export async function resolve(value: AssetValue): Promise<AssetValue> {
  return coreResolve(value, await getStorageProvider())
}

export async function toLink<T extends DictAsset>(v: ValueOrLink<T>): Promise<AssetId> {
  return typeof v === 'string' ? v : store(v)
}

export async function fromLink<T extends DictAsset>(v: ValueOrLink<T>): Promise<T> {
  return typeof v === 'string' ? load(v) as unknown as Promise<T> : v
}

// ===================================================================
// RE-EXPORTS
// ===================================================================

export type { AwsCredentials, BridgeConfig, S3Config } from './config.js'
export {
  resetStorageProvider,
  setBridgeStorageProvider,
  setCustomStorageProvider,
  setLocalWebStorageProvider,
  setS3WebStorageProvider,
} from './storage-factory.js'
export { cidToAssetId, computeHash } from '@playtiss/core'
