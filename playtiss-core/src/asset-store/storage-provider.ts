// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import type { AssetId } from '../asset-id.js'

/**
 * Generic reference tracking for a stored asset.
 *
 * Implementations of the Collaboration Protocol can track which other
 * assets a stored blob references (useful for GC, replication, and
 * dependency analysis). Core ships only the generic `assetReferences`
 * field — downstream SDKs (e.g., the `playtiss` SDK) widen this with
 * their own reference categories via declaration merging or intersection types.
 */
export interface AssetReferences {
  // Asset → Asset references (for compound assets referencing other assets)
  assetReferences?: AssetId[]
}

/**
 * Byte-level storage contract for content-addressed blobs.
 *
 * Any Collaboration Protocol implementation — whether it uses playtiss's
 * Task/Version model or a completely different data model — can provide
 * a StorageProvider to plug into core's hashing and load/store primitives.
 */
export interface StorageProvider {
  hasBuffer(id: AssetId): Promise<boolean>
  fetchBuffer(id: AssetId): Promise<Uint8Array>
  saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences
  ): Promise<void>
}
