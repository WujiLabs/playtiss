// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import type { AssetId, CompoundLazyAsset } from '../index.js'

export type Reference
  = | CompoundAssetReference<CompoundLazyAsset>
    | BinaryAssetReference
export interface AssetReference<P, T> {
  readonly id: AssetId
  readonly ref: P
  load(): Promise<T>
}

export function isReference(input: unknown): input is Reference {
  return (
    input !== null
    && typeof input === 'object'
    && (input instanceof CompoundAssetReference
      || input instanceof BinaryAssetReference)
  )
}
type CompoundAssetLoader<T> = (id: `@${AssetId}`) => Promise<T>
type BinaryAssetLoader = (id: `#${AssetId}`) => Promise<Uint8Array>

export class LoaderError extends Error {}

export class CompoundAssetReference<T>
implements AssetReference<`@${AssetId}`, T> {
  constructor(id: AssetId, loader: CompoundAssetLoader<T> | null) {
    this.id = id
    this.ref = `@${id}`
    this.load = () => {
      if (loader === null) throw new LoaderError('AssetLoader not provided.')
      return loader(this.ref)
    }
  }

  readonly id: AssetId
  readonly ref: `@${AssetId}`
  load: () => Promise<T>
}

export class BinaryAssetReference
implements AssetReference<`#${AssetId}`, Uint8Array> {
  constructor(id: AssetId, loader: BinaryAssetLoader | null) {
    this.id = id
    this.ref = `#${id}`
    this.load = () => {
      if (loader === null) throw new LoaderError('AssetLoader not provided.')
      return loader(this.ref)
    }
  }

  readonly id: AssetId
  readonly ref: `#${AssetId}`
  load: () => Promise<Uint8Array>
}
