// Copyright (c) 2026 Wuji Labs Inc
//
// SDK wrapper smoke test. The core semantics for store/load/resolve
// are exercised in
// `playtiss-core/src/test/asset-store-operations.test.ts`. This file
// only verifies that the SDK's no-arg wrappers route through to
// `@playtiss/core` via the global StorageProvider singleton — i.e.,
// that `setCustomStorageProvider(mock)` followed by `store(value)`
// (no provider arg) actually calls the mock.

import type { AssetId, AssetValue, StorageProvider } from '@playtiss/core'
import { CID } from 'multiformats/cid'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  load,
  resetStorageProvider,
  resolve,
  setCustomStorageProvider,
  store,
} from '../asset-store/index.js'

function makeMemoryStore(): { data: Map<string, Uint8Array>, provider: StorageProvider } {
  const data = new Map<string, Uint8Array>()
  const provider: StorageProvider = {
    async hasBuffer(id: AssetId) { return data.has(id) },
    async fetchBuffer(id: AssetId) {
      const buf = data.get(id)
      if (!buf) throw new Error(`Not found: ${id}`)
      return buf
    },
    async saveBuffer(buffer: Uint8Array, id: AssetId) { data.set(id, buffer) },
  }
  return { data, provider }
}

describe('SDK wrappers route through to @playtiss/core via the global provider', () => {
  beforeEach(() => {
    resetStorageProvider()
  })

  it('store(value) calls the registered provider.saveBuffer', async () => {
    const { data, provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const id = await store({ foo: 'bar' })
    expect(data.size).toBe(1)
    expect(data.has(id)).toBe(true)
  })

  it('load(id) calls the registered provider.fetchBuffer', async () => {
    const { provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const id = await store({ a: 1, b: 'two' })
    const loaded = await load(id)
    expect(loaded).toEqual({ a: 1, b: 'two' })
  })

  it('resolve() walks links via the registered provider', async () => {
    const { provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const innerId = await store({ inner: 42 })
    const outerId = await store({ child: CID.parse(innerId) })
    const loaded = await load(outerId)
    const resolved = await resolve(loaded as AssetValue)
    expect(resolved).toEqual({ child: { inner: 42 } })
  })
})
