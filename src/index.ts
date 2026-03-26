// Copyright (c) 2026 Wuji Labs Inc
export {
  type AssetId,
  isAssetId,
} from './types/asset_id.js'
export {
  type AssetValue,
  CID,
  type DagJsonLink,
  type DictAsset,
  isLink,
  type PlaytissLink,
  type RawLink,
} from './types/asset_value.js'
export type {
  ValueOrLink,
} from './types/playtiss.js'
export {
  type ActionId,
  actionIdToDbFormat,
  dbFormatToActionId,
  default_scope_id,
  getSystemAction,
  getSystemActionDefinitions,
  isSystemAction,
  SYSTEM_ACTIONS,
  type SystemAction,
  type SystemActionId,
} from './types/playtiss.js'
export {
  generateTraceId,
  parseTraceId,
  type TraceId,
  type TraceIdGenerator,
} from './types/trace_id.js'

// provide timestamp
export function getTime() {
  return Date.now()
}
