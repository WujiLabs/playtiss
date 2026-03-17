// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
export type AssetId = SHA256 // hardcode the choice of SHA256 algorithm

const SHA256_LENGTH = 64 // 64 hex characters for 256-bit hash

type SHA256 = string & { length: typeof SHA256_LENGTH }

export type CompoundAssetId = `@${AssetId}`
export type BinaryAssetId = `#${AssetId}`

// utilities for @_ and #_
const SHA256_REGEX = /^[a-f0-9]{64}$/i
export function isAssetId(input: string): input is AssetId {
  return SHA256_REGEX.test(input)
}
export function isCompoundAssetId(input: string): input is CompoundAssetId {
  return input.startsWith('@') && SHA256_REGEX.test(input.slice(1))
}
export function isBinaryAssetId(input: string): input is BinaryAssetId {
  return input.startsWith('#') && SHA256_REGEX.test(input.slice(1))
}
// extract id by removing prefix
export function toAssetId(input: CompoundAssetId | BinaryAssetId): AssetId {
  return input.slice(1) as AssetId
}
