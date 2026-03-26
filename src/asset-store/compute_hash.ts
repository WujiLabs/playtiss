// Copyright (c) 2026 Wuji Labs Inc
import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

import type { AssetId, AssetValue } from '../index.js'

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
 * Applies full Merkle-ization: every nested object/array/binary is replaced
 * by its CID before encoding the top-level block. Returns the CID, encoded
 * bytes, and the flattened value (with sub-values as CID links).
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
 * Uses full Merkle-ization: nested objects, arrays, and binary buffers are
 * recursively hashed as separate blocks. The returned CID depends on the
 * logical content, not on whether sub-values were provided inline or as CID links.
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
