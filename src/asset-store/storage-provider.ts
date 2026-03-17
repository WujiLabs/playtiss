// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId } from '../index.js'
import { type UserActionId, type VersionId } from '../types/playtiss.js'

export interface AssetReferences {
  // Asset → Asset references (for compound assets referencing other assets)
  assetReferences?: AssetId[]
  // Asset → Action references (for workflow definition assets referencing user actions)
  actionReferences?: UserActionId[]
  // Asset → Version references (for context assets referencing versions)
  versionReferences?: VersionId[]
}

export interface StorageProvider {
  hasBuffer(id: AssetId): Promise<boolean>
  fetchBuffer(id: AssetId): Promise<Uint8Array>
  saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences
  ): Promise<void>
}
