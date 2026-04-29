// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

import type { AssetId } from './asset-id.js'
import type { AssetValue } from './asset-value.js'

// Safe cast: we know the CID was created with dag-json/sha256 or raw/sha256
export function cidToAssetId(cid: CID): AssetId {
  return cid.toString() as AssetId
}

/**
 * Recursively flatten an AssetValue so every nested object, array,
 * and binary buffer is replaced by its content-addressed CID.
 * The result is a primitive or CID — no nested structures remain.
 * Pure (no storage I/O).
 */
async function flatten(value: AssetValue): Promise<AssetValue> {
  if (value instanceof CID) return value
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) {
    const { cid } = await Block.encode({ value, codec: raw, hasher: sha256 })
    return cid
  }
  if (Array.isArray(value)) {
    const items = await Promise.all(value.map(v => flatten(v)))
    const { cid } = await Block.encode({ value: items, codec: dagJSON, hasher: sha256 })
    return cid
  }
  // Object: flatten each value then encode this level as a block, returning a CID
  const flat = Object.fromEntries(
    await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await flatten(v)])),
  )
  const { cid } = await Block.encode({ value: flat, codec: dagJSON, hasher: sha256 })
  return cid
}

/**
 * Compute the top-level content-addressed block for any AssetValue.
 *
 * Storage shape: SHALLOW. Returns ONE block — `{cid, bytes, flatValue}`
 * where `bytes` is the encoded TOP-level block ONLY. Sub-blocks
 * produced inside `flatten()` for nested objects/arrays/binaries are
 * NOT returned and NOT saved anywhere; their bytes are discarded
 * after their CID is computed (line 28, 33, 40 above). Caller
 * persists `bytes` (one blob); intermediate encodings vanish.
 *
 * Hash shape: MERKLE. Every nested level is recursively encoded via
 * `Block.encode` and replaced by its CID inside `flatValue` before
 * the top encoding. The CID is therefore content-consistent with
 * deep storage — same logical input produces the same CID regardless
 * of whether sub-fields were provided inline or as CID links — but
 * the caller never has to manage a tree of blobs.
 *
 * For round-trip storage where `load()` returns the same dict
 * structure that was passed in (no further link resolution required),
 * use `store()` / `computeStorageBlock()` from
 * `asset-store/operations.js`. Those use this CID for stability but
 * write the inline encoding for `bytes`.
 *
 * Pure function — no storage side effects.
 */
export async function computeTopBlock(input: AssetValue): Promise<{
  cid: CID
  bytes: Uint8Array
  flatValue: AssetValue
}> {
  if (input instanceof Uint8Array) {
    const block = await Block.encode({ value: input, codec: raw, hasher: sha256 })
    return { cid: block.cid, bytes: block.bytes, flatValue: input }
  }
  if (input === null || typeof input !== 'object') {
    const block = await Block.encode({ value: input, codec: dagJSON, hasher: sha256 })
    return { cid: block.cid, bytes: block.bytes, flatValue: input }
  }
  if (Array.isArray(input)) {
    const items = await Promise.all(input.map(v => flatten(v)))
    const block = await Block.encode({ value: items, codec: dagJSON, hasher: sha256 })
    return { cid: block.cid, bytes: block.bytes, flatValue: items }
  }
  const flat = Object.fromEntries(
    await Promise.all(Object.entries(input).map(async ([k, v]) => [k, await flatten(v)])),
  )
  const block = await Block.encode({ value: flat, codec: dagJSON, hasher: sha256 })
  return { cid: block.cid, bytes: block.bytes, flatValue: flat }
}

/**
 * Compute the canonical content-addressed hash (CID) of any AssetValue.
 *
 * Hash shape: MERKLE — nested objects, arrays, and binary buffers are
 * recursively hashed as separate sub-blocks. The returned CID depends
 * on logical content, not on whether sub-values were provided inline
 * or as CID links.
 *
 * Storage shape: NONE — pure function, no blocks are returned or
 * persisted. If you need bytes-to-store, use `computeTopBlock` (one
 * shallow block) or `store()` (saves via a StorageProvider).
 *
 * Canonical ordering is guaranteed by the dag-json spec: object keys
 * are sorted by UTF-8 byte comparison during encoding, so insertion
 * order does not affect the hash.
 *
 * Pure function — no storage side effects.
 */
export async function computeHash(input: Uint8Array): Promise<AssetId>
export async function computeHash(input: unknown): Promise<AssetId>
export async function computeHash(input: unknown): Promise<AssetId> {
  if (input instanceof CID) return cidToAssetId(input as CID)
  const { cid } = await computeTopBlock(input as AssetValue)
  return cidToAssetId(cid)
}
