// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Asset-store operations: pure compute helpers + StorageProvider-driven
// store / load / resolve. Mirrors the SDK's pattern (in
// `playtiss-public/src/asset-store/index.ts`), but parameterized by
// StorageProvider — no global singleton — so it can be consumed
// directly by anything depending on `@playtiss/core` without pulling
// in the SDK or its global state.
//
// Design notes (read once, never re-derive):
//
//   computeTopBlock (hash.ts) is SHALLOW STORAGE + MERKLE HASH.
//   It returns one block (top bytes); intermediate sub-block bytes
//   from `flatten()` are discarded. The CID is Merkle-recursive for
//   stability across inline-vs-link forms.
//
//   store / computeStorageBlock here are SHALLOW STORAGE + INLINE
//   BYTES with the same Merkle CID. Caller persists one blob per
//   call; bytes are the inline dag-json encoding so `load()` returns
//   the same dict structure that was passed in (no further link
//   resolution required for top-level access).
//
//   load returns AssetValue with CID instances inline; resolve()
//   walks the value and follows every link. Comparison-only callers
//   use the CID directly without any I/O.

import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

import type { AssetId } from '../asset-id.js'
import { type AssetValue, CID } from '../asset-value.js'
import { cidToAssetId, computeTopBlock } from '../hash.js'
import type { AssetReferences, StorageProvider } from './storage-provider.js'

/**
 * Compute the {cid, bytes} pair for storing an AssetValue.
 *
 * Storage shape: SHALLOW + INLINE.
 *   bytes = dagJSON.encode(value)  (or raw codec for Uint8Array)
 *   The bytes are the inline encoding of `value` with sub-CID-links
 *   the caller embedded preserved in-place. Nested objects/arrays
 *   are NOT recursively split into separate blocks.
 *
 * Hash shape: MERKLE.
 *   cid = computeTopBlock(value).cid
 *   The hash is content-consistent across inline-vs-link forms —
 *   same logical input always produces the same CID.
 *
 * Pure — no provider calls. Use this when you need to pre-compute
 * {cid, bytes} for a batched write (e.g. inside a sync DB
 * transaction that can't `await provider.saveBuffer`).
 */
export async function computeStorageBlock(value: AssetValue): Promise<{
  cid: AssetId
  bytes: Uint8Array
}> {
  const { cid } = await computeTopBlock(value)
  const bytes = value instanceof Uint8Array
    ? (await Block.encode({ value, codec: raw, hasher: sha256 })).bytes
    : dagJSON.encode(value)
  return { cid: cidToAssetId(cid), bytes }
}

/**
 * Persist an AssetValue via the StorageProvider. Returns its AssetId.
 *
 * Skips saveBuffer if the asset is already stored (provider.hasBuffer).
 * Tracks `assetReferences` for any CID links the caller embedded in
 * `input` — these are the only references collected; sub-block CIDs
 * generated internally by Merkle hashing are NOT included.
 */
export async function store(
  input: AssetValue,
  provider: StorageProvider,
): Promise<AssetId> {
  if (input instanceof CID) return cidToAssetId(input)
  const { cid, bytes } = await computeStorageBlock(input)
  if (!(await provider.hasBuffer(cid))) {
    const refs = collectCIDLinks(input)
    const refOpt: AssetReferences | undefined
      = refs.length ? { assetReferences: refs } : undefined
    await provider.saveBuffer(bytes, cid, refOpt)
  }
  return cid
}

/**
 * Load an asset by id from the StorageProvider.
 *
 * Returns the asset as an AssetValue with CID instances (AssetLinks)
 * preserved inline. Does NOT recursively follow links — pass the
 * result through `resolve()` if you need full materialization. For
 * dedup / comparison checks, the CID alone is enough; no `load()`
 * call needed.
 */
export async function load(
  id: AssetId,
  provider: StorageProvider,
): Promise<AssetValue> {
  const cid = CID.parse(id)
  const buffer = await provider.fetchBuffer(id)
  return cid.code === raw.code
    ? buffer
    : (dagJSON.decode(buffer) as AssetValue)
}

/**
 * Recursively materialize a value by following every CID link via
 * the provider, until no links remain. Idempotent on link-free input.
 */
export async function resolve(
  value: AssetValue,
  provider: StorageProvider,
): Promise<AssetValue> {
  if (value instanceof CID) {
    const loaded = await load(cidToAssetId(value), provider)
    return resolve(loaded, provider)
  }
  if (value instanceof Uint8Array) return value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return Promise.all(value.map(v => resolve(v, provider)))
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await resolve(v, provider)]),
    ),
  )
}

function collectCIDLinks(value: unknown): AssetId[] {
  if (value instanceof CID) return [cidToAssetId(value)]
  if (value instanceof Uint8Array) return []
  if (Array.isArray(value)) return value.flatMap(v => collectCIDLinks(v))
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .flatMap(v => collectCIDLinks(v))
  }
  return []
}
