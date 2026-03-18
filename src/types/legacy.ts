// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import type { AssetId } from './asset_id.js'
import { type AssetValue, type DictAsset } from './asset_value.js'

// ValueOrRef<T>: either an inline value or a CID string pointing to a stored asset.
// Replaces the old T | CompoundAssetReference<T> pattern.
export type ValueOrRef<T> = T | AssetId

export type Creator
  = | string
    | DictAsset
    | AssetId

export interface Action extends DictAsset {
  creator: Creator
  timestamp: number // integer
  asset_type: 'action'
  description: string
  input_shape: AssetValue
  output_shape: AssetValue
}

export type EventType
  // task is created and finshed synchronously
  // equivalent to (create + claim + deliver)
  = | 'record'
  // marks the creation of task, pending claim
    | 'create'
  // someone claims the task and starts working
    | 'claim'
  // task is finished, asset being delivered
    | 'deliver'
  // task is not finished, WIP asset is optional
    | 'abort'
  // [Internal] for worker's own time tracking
  // provide intermediate results/progress
  // equivalent to (stop + start)
    | 'update'
    | 'start'
    | 'stop'
