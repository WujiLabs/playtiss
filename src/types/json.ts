// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
//
// JSONAsset means it can be saved/loaded via JSON parser
// regular string member is requoted
// Uint8Array is converted to BinaryAssetReference
// Reference is converted to string starting with @ or #

import type { CompoundLazyAsset, LazyAsset } from '../index.js'
import {
  isBinaryAssetId,
  isCompoundAssetId,
  toAssetId,
  type BinaryAssetId,
  type CompoundAssetId,
} from './asset_id.js'
import {
  BinaryAssetReference,
  CompoundAssetReference,
  isReference,
} from './reference.js'

export type JSONAsset
  = | { [x: string]: JSONAsset }
    | JSONAsset[]
    | number
    | boolean
    | null
    | `"${string}"`
    | CompoundAssetId
    | BinaryAssetId

export type DictJSONAsset = { [x: string]: JSONAsset }

export function jsonify(value: unknown): JSONAsset {
  if (typeof value === 'string') {
    return `"${value}"` // quote again
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (
    typeof value === 'undefined'
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    throw new TypeError(
      `JSONAsset cannot represent ${typeof value} value: ${String(value)}`,
    )
  }
  if (value === null) return null
  if (Array.isArray(value)) {
    return value.map(v => jsonify(v))
  }
  if (value instanceof Uint8Array) {
    throw new TypeError(
      `JSONAsset cannot represent Uint8Array. Do you want to use store() instead?`,
    )
  }
  if (isReference(value)) {
    return value.ref
  }
  const obj = Object.fromEntries(
    Object.entries(value).map(([k, v]: [string, unknown]) => [k, jsonify(v)]),
  )
  return obj
}

export function isQuotedString(value: string): value is `"${string}"` {
  return value.startsWith('"') && value.endsWith('"')
}

export function ensureJSONAsset(value: unknown): JSONAsset {
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (
    typeof value === 'undefined'
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    throw new TypeError(
      `JSONAsset cannot represent ${typeof value} value: ${String(value)}`,
    )
  }
  if (typeof value === 'string') {
    if (
      isCompoundAssetId(value)
      || isBinaryAssetId(value)
      || isQuotedString(value)
    ) {
      return value
    }
    throw new TypeError(
      `JSONAsset cannot represent ${typeof value} value: ${String(value)}`,
    )
  }
  if (value instanceof Uint8Array) {
    throw new TypeError('Unexpected Uint8Array in JSONAsset')
  }
  if (isReference(value)) {
    throw new TypeError('Unexpected Reference in JSONAsset')
  }
  if (Array.isArray(value)) {
    return value.map(v => ensureJSONAsset(v))
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]: [string, unknown]) => [
      k,
      ensureJSONAsset(v),
    ]),
  )
}

export function ensureDictJSONAsset(value: unknown): DictJSONAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.constructor !== Object) {
    throw new TypeError('Expected object in DictJSONAsset')
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]: [string, unknown]) => [k, ensureJSONAsset(v)]),
  )
}

export function parseAssetText(text: string): LazyAsset {
  const asset = JSON.parse(text, (_key, value) => {
    if (typeof value !== 'string') return value
    if (isQuotedString(value))
      // regular string
      return value.slice(1, -1) // remove quote
    if (isBinaryAssetId(value)) {
      return new BinaryAssetReference(toAssetId(value), null)
    }
    if (isCompoundAssetId(value)) {
      return new CompoundAssetReference<CompoundLazyAsset>(
        toAssetId(value),
        null,
      )
    }
    throw new TypeError(`Unexpected string value: ${value}`)
  }) as LazyAsset
  return asset
}
