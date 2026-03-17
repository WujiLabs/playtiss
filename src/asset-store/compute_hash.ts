// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import type { AssetId, CompoundLazyAsset, LazyAsset } from '../index.js'
import {
  BinaryAssetReference,
  CompoundAssetReference,
  isReference,
  type Reference,
} from '../types/reference.js'
import promise_map from '../utils/promise_map.js'

// A (shallow) type disallowing nested object or array
// They get serialized and hashed first, and get replaced by the computed hash
// for upper level serialization
type HashableAsset = { [x: string]: Literal } | Literal[] | Literal

type Literal = number | boolean | null | string | Reference

const computeBinaryHash = async (input: ArrayBufferView): Promise<AssetId> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
  const hashArray = Array.from(new Uint8Array(digest)) // convert buffer to byte array
  const hashHex = hashArray
    .map(b => b.toString(16).padStart(2, '0'))
    .join('') // convert bytes to hex string
  return hashHex as AssetId
}
const computeStringHash = async (input: string): Promise<AssetId> => {
  // console.log("hashing:", input);
  const msgUint8 = new TextEncoder().encode(input) // encode as (utf-8) Uint8Array
  const ret = await computeBinaryHash(msgUint8)
  // console.log("result:", ret);
  return ret
}

const isLiteral = (input: LazyAsset): input is Literal => {
  return (
    input === null
    || typeof input === 'boolean'
    || typeof input === 'number'
    || typeof input === 'string'
    || isReference(input)
  )
}

const stringifyLiteral = (input: Literal): string => {
  if (typeof input === 'boolean') {
    return input ? 'true' : 'false'
  }
  if (typeof input === 'number') {
    return input.toString()
  }
  if (input === null) {
    return 'null'
  }
  if (typeof input === 'string') {
    return JSON.stringify(input)
  }
  // Reference
  return input.ref
}

const stringify = (input: HashableAsset): string => {
  if (isLiteral(input)) {
    return stringifyLiteral(input)
  }
  if (Array.isArray(input)) {
    return '[' + input.map(v => stringifyLiteral(v)).join(',') + ']'
  }
  // strings are sorted by UTF-16 code unit order
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort#description
  const keys = Object.keys(input).sort()
  return (
    '{'
    + keys
      .map(k => `${JSON.stringify(k)}:${stringifyLiteral(input[k])}`)
      .join(',')
      + '}'
  )
}

const toLiteral = async (input: HashableAsset): Promise<Literal> => {
  if (isLiteral(input)) {
    return input
  }
  return new CompoundAssetReference<CompoundLazyAsset>(
    await computeStringHash(stringify(input)),
    async () => input,
  )
}

const toHashable = async (input: LazyAsset): Promise<HashableAsset> => {
  if (input instanceof Uint8Array) {
    return new BinaryAssetReference(
      await computeBinaryHash(input),
      async () => input,
    )
  }
  if (isLiteral(input)) {
    return input
  }
  if (Array.isArray(input)) {
    // convert each element in Array<LazyAsset> to Literal
    return promise_map(input, async (value: LazyAsset): Promise<Literal> => {
      return toLiteral(await toHashable(value))
    })
  }
  // convert each value in Map<string, LazyAsset> to Literal
  return Object.fromEntries(
    await promise_map(
      Object.entries(input),
      async ([key, value]: [string, LazyAsset]): Promise<[string, Literal]> => {
        return [key, await toLiteral(await toHashable(value))]
      },
    ),
  )
}

export async function computeHash(input: LazyAsset): Promise<AssetId> {
  if (isReference(input)) {
    // Do not rehash references
    return input.id
  }
  if (input instanceof Uint8Array) {
    return computeBinaryHash(input)
  }
  return computeStringHash(stringify(await toHashable(input)))
}
