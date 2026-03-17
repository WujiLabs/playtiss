// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  BinaryAssetReference,
  CompoundAssetReference,
  isReference,
  type Reference,
} from './types/reference.js'
export type {
  Creator,
  EventType,
  ValueOrRef,
} from './types/legacy.js'
export { BinaryAssetReference, CompoundAssetReference, isReference }

export {
  isAssetId,
  isBinaryAssetId,
  isCompoundAssetId,
  toAssetId,
  type AssetId,
  type BinaryAssetId,
  type CompoundAssetId,
} from './types/asset_id.js'

export {
  generateTraceId,
  parseTraceId,
  type TraceId,
  type TraceIdGenerator,
} from './types/trace_id.js'

export {
  actionIdToDbFormat,
  dbFormatToActionId,
  default_scope_id,
  getSystemAction,
  getSystemActionDefinitions,
  isSystemAction,
  SYSTEM_ACTIONS,
  type ActionId,
  type SystemAction,
  type SystemActionId,
} from './types/playtiss.js'

export type Asset
  = | { [x: string]: Asset }
    | Array<Asset>
    | number
    | boolean
    | null
    | string
    | Uint8Array // essentially, a JSONValue type with arbitrary binary buffer

// LazyAsset means the members/elements can be lazy loaded,
// only the reference are kept in place
export type LazyAsset
  = | CompoundLazyAsset
    | number
    | boolean
    | null
    | string
    | Reference
    | Uint8Array

// ReferencedAsset means ArrayBuffers are all converted to BinaryAssetReferences
// some nested array/dict may also be CompoundAssetReferences
// this format allows jsonify() without async store
export type ReferencedAsset
  = | { [x: string]: ReferencedAsset }
    | ReferencedAsset[]
    | number
    | boolean
    | null
    | string
    | Reference

export type DictLazyAsset = { [x: string]: LazyAsset }

// Array<LazyAsset> would be rare in actual code because it can
// be represented by DictLazyAsset: {idx.toString(): value}
// However, it may be used commonly in internal representation
// for Yjs-like documents when we add collaboration later
export type CompoundLazyAsset = DictLazyAsset | Array<LazyAsset>

// provide timestamp
export function getTime() {
  return Date.now()
}
