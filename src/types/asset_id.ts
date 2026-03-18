// Copyright (c) 2026 Wuji Labs Inc
import { CID } from 'multiformats/cid'

// AssetId is an IPLD CID string (e.g. "bafyreib..." for dag-json, "bafkrei..." for raw binary).
// Replaces the old SHA-256 hex string format.
export type AssetId = string

export function isAssetId(input: string): input is AssetId {
  try { CID.parse(input); return true }
  catch { return false }
}
