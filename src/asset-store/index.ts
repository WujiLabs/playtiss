// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  isBinaryAssetId,
  isCompoundAssetId,
  toAssetId,
  type AssetId,
  type BinaryAssetId,
  type CompoundAssetId,
  type CompoundLazyAsset,
  type DictLazyAsset,
  type LazyAsset,
  type ValueOrRef,
} from '../index.js'
import { isQuotedString, type JSONAsset } from '../types/json.js'
import {
  BinaryAssetReference,
  CompoundAssetReference,
  LoaderError,
  isReference,
  type Reference,
} from '../types/reference.js'
import promise_map from '../utils/promise_map.js'
import { computeHash } from './compute_hash.js'
import { fetchBuffer, hasBuffer, saveBuffer } from './storage-factory.js'

// Interface to track references during asset serialization
interface ReferenceCollector {
  references: Set<AssetId> // AssetIds of referenced assets
}

async function asset_to_json(
  input: LazyAsset,
  collector?: ReferenceCollector,
): Promise<JSONAsset> {
  if (input === null) return null
  if (input instanceof Uint8Array) {
    const hash = await computeHash(input)
    if (!(await hasBuffer(hash))) {
      await saveBuffer(input, hash)
    }
    // Collect this binary asset reference
    if (collector) {
      collector.references.add(hash)
    }
    return `#${hash}` as BinaryAssetId
  }
  if (isReference(input)) {
    // Collect this reference
    if (collector) {
      collector.references.add(input.id)
    }
    return input.ref
  }
  if (typeof input === 'string') {
    return `"${input}"` // quote again
  }
  if (typeof input === 'boolean' || typeof input === 'number') return input
  if (Array.isArray(input)) {
    return await promise_map(input, v => asset_to_json(v, collector))
  }
  const obj = Object.fromEntries(
    await promise_map(
      Object.entries(input),
      async ([k, v]: [string, LazyAsset]) => [
        k,
        await asset_to_json(v, collector),
      ],
    ),
  )
  return obj
}

async function asset_to_buffer(
  input: LazyAsset,
): Promise<{ buffer: Uint8Array, references: AssetId[] }> {
  const collector: ReferenceCollector = { references: new Set() }
  const jsonAsset = await asset_to_json(input, collector)
  const str = JSON.stringify(jsonAsset)
  const buffer = new TextEncoder().encode(str)
  return { buffer, references: Array.from(collector.references) }
}

function buffer_to_asset(input: Uint8Array): LazyAsset {
  const str = new TextDecoder('utf-8').decode(input)
  const obj = JSON.parse(str, (_key, value) => {
    if (typeof value !== 'string') return value
    if (isQuotedString(value))
      // regular string
      return value.slice(1, -1) // remove quote
    if (isBinaryAssetId(value)) {
      return new BinaryAssetReference(toAssetId(value), binary_asset_loader)
    }
    if (isCompoundAssetId(value)) {
      return new CompoundAssetReference<CompoundLazyAsset>(
        toAssetId(value),
        compound_asset_loader<CompoundLazyAsset>,
      )
    }
  }) as LazyAsset
  return obj
}

async function binary_asset_loader(
  asset_id: BinaryAssetId,
): Promise<Uint8Array> {
  return await fetchBuffer(toAssetId(asset_id))
}

async function compound_asset_loader<T extends CompoundLazyAsset>(
  asset_id: CompoundAssetId,
): Promise<T> {
  const result = await fetchBuffer(toAssetId(asset_id))
  const output = buffer_to_asset(result)
  if (typeof output === 'object' && output !== null) {
    return output as unknown as T
  }
  throw new Error('Invalid compound asset format')
}

export async function load(asset_id: BinaryAssetId): Promise<Uint8Array>
export async function load<T extends CompoundLazyAsset>(
  asset_id: CompoundAssetId,
): Promise<T>
export async function load<T extends CompoundLazyAsset>(
  asset_id: BinaryAssetId | CompoundAssetId,
  expand_all: boolean = false,
): Promise<LazyAsset> {
  try {
    console.debug(`Loading asset: ${asset_id} (expand_all: ${expand_all})`)

    if (isBinaryAssetId(asset_id)) {
      const result = await binary_asset_loader(asset_id)
      console.debug(
        `Binary asset loaded: ${asset_id} (${result.length} bytes)`,
      )
      return result
    }

    const output = await compound_asset_loader<T>(asset_id)
    console.debug(`Compound asset loaded: ${asset_id}`)

    return expand_all ? expand_lazy_asset(output) : output
  }
  catch (error: any) {
    console.error(`Failed to load asset ${asset_id}:`, {
      assetId: asset_id,
      assetType: isBinaryAssetId(asset_id) ? 'binary' : 'compound',
      expandAll: expand_all,
      error: error.message,
    })

    // Re-throw with enhanced context
    throw new Error(`Asset loading failed for ${asset_id}: ${error.message}`)
  }
}

export async function store(
  input: Exclude<LazyAsset, Uint8Array | Reference>,
): Promise<CompoundAssetId>
export async function store(input: Uint8Array): Promise<BinaryAssetId>
export async function store(
  input: LazyAsset,
): Promise<CompoundAssetId | BinaryAssetId> {
  try {
    if (input instanceof Uint8Array) {
      console.debug(`Storing binary asset (${input.length} bytes)`)

      const hash = await computeHash(input)
      const assetId = `#${hash}` as BinaryAssetId

      if (!(await hasBuffer(hash))) {
        console.debug(`Saving new binary asset: ${assetId}`)
        await saveBuffer(input, hash)
      }
      else {
        console.debug(`Binary asset already exists: ${assetId}`)
      }

      return assetId
    }
    else {
      console.debug(`Storing compound asset`, { type: typeof input })

      const hash = await computeHash(input)
      const assetId = `@${hash}` as CompoundAssetId

      if (!(await hasBuffer(hash))) {
        console.debug(`Saving new compound asset: ${assetId}`)

        const { buffer, references } = await asset_to_buffer(input)

        // Save buffer with references in one atomic operation
        const assetRefs
          = references.length > 0 ? { assetReferences: references } : undefined
        await saveBuffer(buffer, hash, assetRefs)

        if (references.length > 0) {
          console.debug(
            `Saved asset with ${references.length} references: ${assetId}`,
          )
        }
      }
      else {
        console.debug(`Compound asset already exists: ${assetId}`)
      }

      return assetId
    }
  }
  catch (error: any) {
    const inputType = input instanceof Uint8Array ? 'binary' : 'compound'
    const inputSize
      = input instanceof Uint8Array ? input.length : JSON.stringify(input).length

    console.error(`Failed to store ${inputType} asset:`, {
      inputType,
      inputSize,
      error: error.message,
    })

    // Re-throw with enhanced context
    throw new Error(
      `Asset storage failed for ${inputType} asset (${inputSize} bytes): ${error.message}`,
    )
  }
}

async function expand_lazy_asset(input: LazyAsset): Promise<LazyAsset> {
  if (input === null) return null
  if (input instanceof Uint8Array) return input
  if (isReference(input)) {
    return expand_lazy_asset(await input.load())
  }
  if (typeof input === 'string') return input
  if (typeof input === 'boolean' || typeof input === 'number') return input
  if (Array.isArray(input)) {
    return await promise_map(input, v => expand_lazy_asset(v))
  }
  const obj = Object.fromEntries(
    await promise_map(
      Object.entries(input),
      async ([k, v]: [string, LazyAsset]) => [k, await expand_lazy_asset(v)],
    ),
  )
  return obj
}

export async function toReference<T extends DictLazyAsset>(
  value: ValueOrRef<T>,
): Promise<CompoundAssetReference<T>> {
  if (isReference(value)) {
    return value as CompoundAssetReference<T>
  }
  else {
    const stored = await store(value)
    if (isBinaryAssetId(stored)) {
      throw new Error(
        'Expected compound asset reference but got binary asset reference',
      )
    }
    return new CompoundAssetReference<T>(
      toAssetId(stored),
      async (id: CompoundAssetId) => {
        const result = await compound_asset_loader<T>(id)
        return result
      },
    )
  }
}

export async function toValue<T extends DictLazyAsset>(
  reference: ValueOrRef<T>,
): Promise<T> {
  if (isReference(reference)) {
    try {
      // may skip download if value is cached
      const result = await reference.load()
      if (typeof result === 'object' && result !== null) {
        return result as unknown as T
      }
      throw new Error('Invalid asset format')
    }
    catch (e) {
      if (!(e instanceof LoaderError)) {
        console.error(e)
      }
      // Create a new reference with the correct loader
      const newRef = new CompoundAssetReference<T>(
        toAssetId(reference.ref),
        async (id: CompoundAssetId) => {
          const result = await compound_asset_loader<T>(id)
          return result
        },
      )
      const result = await newRef.load()
      if (typeof result === 'object' && result !== null) {
        return result as unknown as T
      }
      throw new Error('Invalid asset format')
    }
  }
  else {
    return reference
  }
}

// ===================================================================
// WEB ENVIRONMENT API
// ===================================================================

// Re-export web storage APIs for easy access
export {
  resetStorageProvider,
  setBridgeStorageProvider,
  setCustomStorageProvider,
  setLocalWebStorageProvider,
  setS3WebStorageProvider,
} from './storage-factory.js'

// Re-export computeHash for caching use cases
export { computeHash } from './compute_hash.js'

// Re-export types for web API
export type { AwsCredentials, BridgeConfig, S3Config } from './config.js'
