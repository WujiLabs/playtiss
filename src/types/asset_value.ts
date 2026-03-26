// Copyright (c) 2026 Wuji Labs Inc
import * as dagJSON from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import type { Link, SHA_256 } from 'multiformats/link/interface'

export { CID }

// Derive codec type-level constants from the packages themselves
type DagJsonCode = typeof dagJSON.code // 297
type RawCode = typeof raw.code // 85

// Replaces LazyAsset — the native IPLD dag-json value type.
// Primitives, objects, arrays, binary (Uint8Array), and CID links are all valid.
// When dag-json encodes this:
//   Uint8Array → {"/": {"bytes": "base64pad..."}}
//   CID        → {"/": "cidString"}
export type AssetValue
  = | { [key: string]: AssetValue }
    | AssetValue[]
    | string
    | number
    | boolean
    | null
    | Uint8Array
    | CID

// Replaces DictLazyAsset — a plain object whose values are AssetValues.
export type DictAsset = { [key: string]: AssetValue }

// Playtiss link types: always CIDv1 + sha256
// DagJsonLink excludes Uint8Array — binary goes through raw codec
export type DagJsonLink<T = Exclude<AssetValue, Uint8Array>> = Link<T, DagJsonCode, SHA_256, 1>
export type RawLink = Link<Uint8Array, RawCode, SHA_256, 1>
export type PlaytissLink = DagJsonLink | RawLink

// Type guard using CID.asCID() for cross-version interop,
// then checks codec + hash algorithm match playtiss conventions.
export function isLink(value: unknown): value is CID<unknown, DagJsonCode | RawCode, SHA_256, 1> {
  const cid = CID.asCID(value)
  if (cid === null) return false
  if (cid.multihash.code !== sha256.code) return false
  if (cid.code !== dagJSON.code && cid.code !== raw.code) return false
  return true
}
