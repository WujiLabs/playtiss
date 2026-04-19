// Copyright (c) 2026 Wuji Labs Inc
import type { AssetReferences } from '@playtiss/core'

import type { UserActionId, VersionId } from '../types/playtiss.js'

/**
 * playtiss SDK-widened asset-reference tracking.
 *
 * Extends the generic `AssetReferences` from `@playtiss/core` (which tracks
 * only blob-level `assetReferences: AssetId[]`) with playtiss-specific
 * categories: `actionReferences` (to UserActionIds) and `versionReferences`
 * (to VersionIds). The SDK uses these for GC and dependency tracking on top
 * of core's generic blob-level reference set.
 *
 * The rename from `AssetReferences` to `PlaytissAssetReferences` avoids a
 * same-name collision with core's interface — two shapes, one identifier,
 * across an import boundary is a trap. Consumers can now see at the import
 * site whether they are handling the generic core shape or playtiss's
 * widened shape.
 */
export interface PlaytissAssetReferences extends AssetReferences {
  // Asset → Action references (for workflow definition assets referencing user actions)
  actionReferences?: UserActionId[]
  // Asset → Version references (for context assets referencing versions)
  versionReferences?: VersionId[]
}
