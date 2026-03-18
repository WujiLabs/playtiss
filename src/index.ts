// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
export type {
  Creator,
  EventType,
  ValueOrRef,
} from './types/legacy.js'

export {
  CID,
  isLink,
  type AssetValue,
  type DictAsset,
} from './types/asset_value.js'

export {
  isAssetId,
  type AssetId,
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

// provide timestamp
export function getTime() {
  return Date.now()
}
