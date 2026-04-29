// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// @playtiss/core — Vocabulary of the Playtiss Collaboration Protocol
//
// Content-addressed DAG primitives where human and AI nodes are peer editors.
// This package defines the TYPE RELATIONSHIPS of the protocol (TaskLike,
// RevisionLike, ActionLike generics) plus the concrete primitives needed to
// compute CIDs and serialize graphs. Concrete workflow types (Task, Revision,
// Action) are implemented by consumers (e.g. the `playtiss` SDK) that extend
// the relationship generics.
//
// The public surface is every symbol explicitly re-exported here. Adding a
// new module under src/ does NOT automatically widen the public API — a new
// export must be added below with intent. Sub-path entry points (see
// package.json `exports`) provide tree-shaking ergonomics; they re-export
// the same symbols from their respective modules.

// ---- asset-id -------------------------------------------------------------
export type { AssetId } from './asset-id.js'
export { isAssetId } from './asset-id.js'

// ---- asset-value ----------------------------------------------------------
export type {
  AssetValue,
  DagJsonLink,
  DictAsset,
  PlaytissLink,
  RawLink,
} from './asset-value.js'
export { CID, isLink } from './asset-value.js'

// ---- asset-store (storage contract + operations) --------------------------
export { computeStorageBlock, load, resolve, store } from './asset-store/index.js'
export type { AssetReferences, StorageProvider } from './asset-store/index.js'

// ---- graph ----------------------------------------------------------------
export type { Graph, GraphEdge, GraphNode } from './graph.js'

// ---- hash -----------------------------------------------------------------
export { cidToAssetId, computeHash, computeTopBlock } from './hash.js'

// ---- json -----------------------------------------------------------------
export { dagJSON, decodeFromString, encodeToString } from './json.js'

// ---- task (relationship generics + branded ids) --------------------------
export type {
  ActionId,
  ActionLike,
  ActorId,
  DefaultAction,
  DefaultRevision,
  DefaultTask,
  NamespacedActionId,
  RevisionId,
  RevisionLike,
  SystemActionId,
  TaskId,
  TaskLike,
  UserActionId,
  ValueOrLink,
} from './task.js'
export { isSystemAction } from './task.js'

// ---- trace-id -------------------------------------------------------------
export type { TraceId } from './trace-id.js'
export {
  generateOperationId,
  generateTraceId,
  generateTraceIdBytes,
  isTraceId,
  parseTraceId,
  TraceIdGenerator,
} from './trace-id.js'
