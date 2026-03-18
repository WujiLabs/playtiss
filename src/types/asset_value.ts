// Copyright (c) 2026 Wuji Labs Inc
import { CID } from 'multiformats/cid'

export { CID }

// Replaces LazyAsset — the native IPLD dag-json value type.
// Primitives, objects, arrays, binary (Uint8Array), and CID links are all valid.
// When dag-json encodes this:
//   Uint8Array → {"/": {"bytes": "base64pad..."}}
//   CID        → {"/": "cidString"}
export type AssetValue =
  | { [key: string]: AssetValue }
  | AssetValue[]
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | CID

// Replaces DictLazyAsset — a plain object whose values are AssetValues.
export type DictAsset = { [key: string]: AssetValue }

// Returns true if value is an IPLD CID (content link).
export function isLink(value: unknown): value is CID {
  return value instanceof CID
}
