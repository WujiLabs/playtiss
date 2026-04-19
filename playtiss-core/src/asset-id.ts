// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as dagJSON from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

// AssetId: branded string — prevents accidental plain string assignment.
// Uses a unique symbol brand to avoid conflict with multiformats' Phantom<Link> types.
declare const AssetIdBrand: unique symbol
export type AssetId = string & { readonly [AssetIdBrand]: true }

// Strict: must be a valid CID with playtiss-compatible codec + hash.
export function isAssetId(input: string): input is AssetId {
  try {
    const cid = CID.parse(input)
    if (cid.multihash.code !== sha256.code) return false
    if (cid.code !== dagJSON.code && cid.code !== raw.code) return false
    return true
  }
  catch { return false }
}
