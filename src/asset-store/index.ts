// Copyright (c) 2026 Wuji Labs Inc
import * as dagJSON from '@ipld/dag-json'
import type { AssetId, AssetValue, DictAsset, ValueOrLink } from '@playtiss/core'
import { cidToAssetId, computeTopBlock } from '@playtiss/core'
import * as Block from 'multiformats/block'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

import { fetchBuffer, hasBuffer, saveBuffer } from './storage-factory.js'

function collectCIDLinks(value: unknown): AssetId[] {
  if (value instanceof CID) return [cidToAssetId(value)]
  if (value instanceof Uint8Array) return []
  if (Array.isArray(value)) return value.flatMap(v => collectCIDLinks(v))
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(v => collectCIDLinks(v))
  }
  return []
}

/**
 * Content-address and persist a single block for the given value.
 *
 * Two concerns, intentionally separated:
 *
 * 1. The returned CID is always the Merkle-ized hash (computed via
 *    `computeHash`) — stable regardless of whether nested sub-values were
 *    passed inline or as CID links. Two equivalent logical values always
 *    resolve to the same CID, enabling deduplication.
 *
 * 2. The persisted bytes are the INLINE `dag-json` encoding of `input`
 *    (only top-level CID values are embedded as links; nested objects and
 *    arrays are NOT recursively split into separate blocks). One I/O per
 *    call. `load(id)` returns what was written — use `resolve()` to
 *    materialize any CID links the caller chose to include.
 *
 * `assetReferences` tracks only CID links explicitly present in the original
 * input (i.e. values the caller already stored and linked), not internally-
 * generated sub-object CIDs.
 */
export async function store(input: AssetValue): Promise<AssetId> {
  if (input instanceof CID) return cidToAssetId(input)
  // CID is computed via Merkle hash (stable whether sub-values are inline or linked)
  const { cid } = await computeTopBlock(input)
  const id = cidToAssetId(cid)
  if (!(await hasBuffer(id))) {
    // Intentionally store the inline encoding (not Merkle-ized), so load()
    // returns the object as-written and no sub-blocks need additional I/O.
    const bytes = input instanceof Uint8Array
      ? Block.encode({ value: input, codec: raw, hasher: sha256 }).then(b => b.bytes)
      : Promise.resolve(dagJSON.encode(input))
    const refs = collectCIDLinks(input)
    await saveBuffer(await bytes, id, refs.length ? { assetReferences: refs } : undefined)
  }
  return id
}

export async function load(id: AssetId): Promise<AssetValue> {
  const cid = CID.parse(id)
  const buffer = await fetchBuffer(id)
  return cid.code === raw.code ? buffer : dagJSON.decode(buffer) as AssetValue
}

/**
 * Fully materialize a value by recursively resolving all CID links.
 * Use `resolve(await load(id))` to get the original nested structure back.
 */
export async function resolve(value: AssetValue): Promise<AssetValue> {
  if (value instanceof CID) {
    const loaded = await load(cidToAssetId(value))
    return resolve(loaded)
  }
  if (value instanceof Uint8Array || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Promise.all(value.map(v => resolve(v)))
  return Object.fromEntries(
    await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolve(v)])),
  )
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
