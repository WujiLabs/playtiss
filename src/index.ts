// Copyright (c) 2026 Wuji Labs Inc
//
// playtiss SDK — the reference Collaboration Protocol implementation.
//
// Core vocabulary (TraceId, AssetId, AssetValue, DictAsset, CID, computeHash,
// Graph, TaskLike/RevisionLike/ActionLike, StorageProvider, etc.) lives in
// @playtiss/core (MIT). Import directly from there:
//
//   import type { AssetId, TraceId, DictAsset } from '@playtiss/core'
//   import { computeHash } from '@playtiss/core'
//
// This barrel exports ONLY the SDK-specific concrete data model (Task,
// Version, Action, VersionType, SYSTEM_ACTIONS registry).

export {
  actionIdToDbFormat,
  dbFormatToActionId,
  default_scope_id,
  getSystemAction,
  getSystemActionDefinitions,
  SYSTEM_ACTIONS,
  type SystemAction,
} from './system-actions.js'
export type {
  Action,
  ErrorVersion,
  ImplementationVersion,
  OutputVersion,
  SnapshotVersion,
  Task,
  Version,
  VersionType,
  WorkflowDefinitionVersion,
} from './types/playtiss.js'
