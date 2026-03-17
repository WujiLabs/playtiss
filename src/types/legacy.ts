// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import type { DictLazyAsset, LazyAsset } from '../index.js'
import { CompoundAssetReference } from './reference.js'

export type ValueOrRef<T> = T | CompoundAssetReference<T>

export type Creator
  = | string
    | DictLazyAsset
    | CompoundAssetReference<DictLazyAsset>
// ensure that all values are LazyAsset type
// as a result, there's no member function
// type ValueIsLazyAsset<T> = {
//   [key in keyof T]: LazyAsset;
// }

// export interface NodeBase<T extends ValueIsLazyAsset<T>> {
//   creator: Creator
//   timestamp: number // integer
//   asset_type: string
// }

export interface Action extends DictLazyAsset {
  creator: Creator
  timestamp: number // integer
  asset_type: 'action'
  description: string
  input_shape: LazyAsset
  output_shape: LazyAsset
}

// export interface PendingTask extends NodeBase<PendingTask> {
//   asset_type: 'pending_task'
//   // PendingTask does not include timestamp
//   // The creation of such action+input combination
//   // is only inferred via event record
//   timestamp: 0
//   action: ValueOrRef<Action>
//   input: DictLazyAsset
// }

// export interface Task extends NodeBase<Task> {
//   asset_type: 'task'
//   // Task does not include timestamp
//   // The creation of such action+input combination
//   // is only inferred via event record
//   timestamp: 0
//   action: ValueOrRef<Action>
//   input: DictLazyAsset
// }

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

// export interface Event<T extends EventType = EventType>
//   extends NodeBase<Event<T>> {
//   asset_type: 'event'
//   task: ValueOrRef<Task>
//   event_type: T
//   output: LazyAsset
// }
