// Copyright (c) 2026 Wuji Labs Inc
import { CID } from 'multiformats/cid'
import * as Block from 'multiformats/block'
import * as dagJSON from '@ipld/dag-json'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import type { AssetId, AssetValue, DictAsset, ValueOrLink } from '../index.js'
import { cidToAssetId, computeTopBlock } from './compute_hash.js'
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
 * The stored bytes are the fully Merkle-ized encoding (all nested objects/arrays/
 * binaries replaced by CID links), ensuring the CID matches `computeHash(input)`.
 * Sub-values are NOT stored as independent blocks — one I/O per call.
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
    // Store the original value as-is (not Merkle-ized), so load() returns the full object
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
// WEB ENVIRONMENT API
// ===================================================================

export {
  resetStorageProvider,
  setBridgeStorageProvider,
  setCustomStorageProvider,
  setLocalWebStorageProvider,
  setS3WebStorageProvider,
} from './storage-factory.js'

export { cidToAssetId, computeHash } from './compute_hash.js'
export type { AwsCredentials, BridgeConfig, S3Config } from './config.js'
