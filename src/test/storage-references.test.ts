// Copyright (c) 2026 Wuji Labs Inc
// Type-level assertions for the SDK-widened AssetReferences.
import type { AssetId, AssetReferences as CoreAssetReferences } from '@playtiss/core'
import { describe, expect, it } from 'vitest'

import type { PlaytissAssetReferences } from '../asset-store/storage-references.js'
import type { UserActionId, RevisionId } from '../types/playtiss.js'

// ------------------------------------------------------------------
// Compile-time conformance: PlaytissAssetReferences extends the core shape
// ------------------------------------------------------------------
type _widensCore = PlaytissAssetReferences extends CoreAssetReferences ? true : never

// If the widening ever drops the base field, this line fails to compile.
type _keepsAssetReferencesField
  = PlaytissAssetReferences['assetReferences'] extends AssetId[] | undefined ? true : never

// SDK-specific fields must be present on the widened interface.
type _hasActionReferences
  = PlaytissAssetReferences['actionReferences'] extends UserActionId[] | undefined ? true : never
type _hasVersionReferences
  = PlaytissAssetReferences['versionReferences'] extends RevisionId[] | undefined ? true : never

type _witnesses = [
  _widensCore,
  _keepsAssetReferencesField,
  _hasActionReferences,
  _hasVersionReferences,
]

describe('PlaytissAssetReferences', () => {
  it('accepts a fully-populated instance with all three reference kinds', () => {
    const refs: PlaytissAssetReferences = {
      assetReferences: ['bafyreiabc' as AssetId],
      actionReferences: ['019d9f37-9321-85a2-8bcc-23dd72000001' as UserActionId],
      versionReferences: ['019d9f37-9321-85a2-8bcc-23dd72000002' as RevisionId],
    }
    expect(refs.assetReferences).toHaveLength(1)
    expect(refs.actionReferences).toHaveLength(1)
    expect(refs.versionReferences).toHaveLength(1)
  })

  it('accepts an empty instance (all fields optional)', () => {
    const refs: PlaytissAssetReferences = {}
    expect(refs.assetReferences).toBeUndefined()
    expect(refs.actionReferences).toBeUndefined()
    expect(refs.versionReferences).toBeUndefined()
  })

  it('accepts a core-only instance (SDK fields optional)', () => {
    const coreOnly: CoreAssetReferences = { assetReferences: ['bafyreiabc' as AssetId] }
    // Core-shaped value must be assignable to the widened type (extension direction).
    const refs: PlaytissAssetReferences = coreOnly
    expect(refs.assetReferences).toEqual(['bafyreiabc'])
  })
})
