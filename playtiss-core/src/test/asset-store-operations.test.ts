// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Adapted from playtiss-public/src/test/normalize-resolve.test.ts.
// Original tests targeted the SDK's global-singleton API; here they
// drive core's parameterized store/load/resolve directly. The
// semantic invariants (Merkle dedup, single-block I/O, link
// preservation by load, recursive resolve) are unchanged.

import * as dagJSON from '@ipld/dag-json'
import * as raw from 'multiformats/codecs/raw'
import { describe, expect, it } from 'vitest'

import type { AssetId } from '../asset-id.js'
import {
  computeStorageBlock,
  load,
  resolve,
  store,
} from '../asset-store/operations.js'
import type { StorageProvider } from '../asset-store/storage-provider.js'
import { type AssetValue, CID } from '../asset-value.js'

// ---- In-memory storage provider for tests ----
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

// ============================================================
// computeStorageBlock — pure compute (no provider)
// ============================================================

describe('computeStorageBlock', () => {
  it('is pure — does not call a StorageProvider', async () => {
    let called = false
    const spy: StorageProvider = {
      async hasBuffer() {
        called = true
        return false
      },
      async fetchBuffer() {
        called = true
        return new Uint8Array()
      },
      async saveBuffer() { called = true },
    }
    // computeStorageBlock takes no provider, but verify the function
    // does not somehow reach into a global. (Sanity — it has no
    // global to reach into.)
    void spy
    await computeStorageBlock({ a: 1, nested: { b: 2 } })
    expect(called).toBe(false)
  })

  it('CID equals (await store(value, provider)) for the same value', async () => {
    const { provider } = makeMemoryStore()
    const value: AssetValue = { role: 'user', content: [1, 2, 3] }
    const { cid: computed } = await computeStorageBlock(value)
    const stored = await store(value, provider)
    expect(computed).toBe(stored)
  })

  it('produces inline bytes — decode round-trips to the original dict', async () => {
    const value: AssetValue = { a: { b: 1 }, c: [2, 3] }
    const { bytes } = await computeStorageBlock(value)
    const decoded = dagJSON.decode(bytes) as Record<string, unknown>
    expect(decoded).toEqual(value)
  })

  it('uses raw codec for Uint8Array input', async () => {
    const { cid } = await computeStorageBlock(new Uint8Array([1, 2, 3]))
    expect(CID.parse(cid).code).toBe(raw.code)
  })

  it('is deterministic and key-order independent', async () => {
    const a = await computeStorageBlock({ x: 1, y: 2 })
    const b = await computeStorageBlock({ y: 2, x: 1 })
    expect(a.cid).toBe(b.cid)
  })
})

// ============================================================
// store — Merkle deduplication
// ============================================================

describe('store — Merkle deduplication', () => {
  it('binary: store({data: buf}) === store({data: CID(buf)})', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([1, 2, 3])
    const bufId = await store(buf, provider)
    const id1 = await store({ data: buf }, provider)
    const id2 = await store({ data: CID.parse(bufId) }, provider)
    expect(id1).toBe(id2)
  })

  it('compound: store({config: {x:1}}) === store({config: CID({x:1})})', async () => {
    const { provider } = makeMemoryStore()
    const inner = { x: 1 }
    const innerId = await store(inner, provider)
    const id1 = await store({ config: inner }, provider)
    const id2 = await store({ config: CID.parse(innerId) }, provider)
    expect(id1).toBe(id2)
  })

  it('array: store({items: [1,2,3]}) === store({items: CID([1,2,3])})', async () => {
    const { provider } = makeMemoryStore()
    const arr: AssetValue = [1, 2, 3]
    const arrId = await store(arr, provider)
    const id1 = await store({ items: arr }, provider)
    const id2 = await store({ items: CID.parse(arrId) }, provider)
    expect(id1).toBe(id2)
  })

  it('deep nested dedup: {outer: {inner: buf}} vs {outer: CID({inner: CID(buf)})}', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([7, 8, 9])
    const bufId = await store(buf, provider)
    const innerObj = { inner: buf }
    const innerId = await store(innerObj, provider)
    const id1 = await store({ outer: innerObj }, provider)
    const id2 = await store({ outer: CID.parse(innerId) }, provider)
    expect(id1).toBe(id2)
    const innerLinked = { inner: CID.parse(bufId) }
    const id3 = await store({ outer: innerLinked }, provider)
    expect(id1).toBe(id3)
  })

  it('is idempotent: same input stored twice returns same CID', async () => {
    const { data, provider } = makeMemoryStore()
    const id1 = await store({ a: 1 }, provider)
    const sizeBefore = data.size
    const id2 = await store({ a: 1 }, provider)
    expect(id1).toBe(id2)
    expect(data.size).toBe(sizeBefore)
  })

  it('top-level binary produces raw codec CID', async () => {
    const { provider } = makeMemoryStore()
    const id = await store(new Uint8Array([42]), provider)
    expect(CID.parse(id).code).toBe(raw.code)
  })

  it('top-level object produces dag-json codec CID', async () => {
    const { provider } = makeMemoryStore()
    const id = await store({ foo: 'bar' }, provider)
    expect(CID.parse(id).code).toBe(dagJSON.code)
  })

  it('stored block is the inline encoding (single I/O; sub-objects not split)', async () => {
    const { data, provider } = makeMemoryStore()
    // store() persists exactly one block per call. Nested
    // objects/arrays are NOT recursively split. Stored bytes are
    // the inline dag-json encoding of the input. (Merkle-ization
    // happens in CID computation, not in what's written to disk.)
    await store({ a: { b: 1 }, c: [2, 3] }, provider)
    expect(data.size).toBe(1)
    const [bytes] = [...data.values()]
    const decoded = dagJSON.decode(bytes) as Record<string, unknown>
    expect(decoded).toEqual({ a: { b: 1 }, c: [2, 3] })
  })

  it('store() produces exactly one block per call (O(1) I/O)', async () => {
    const { data, provider } = makeMemoryStore()
    const inner = { val: 99 }
    await store({ a: inner, b: inner }, provider)
    expect(data.size).toBe(1)
  })

  it('CID input returns the CID string without additional storage', async () => {
    const { data, provider } = makeMemoryStore()
    const buf = new Uint8Array([1])
    const id = await store(buf, provider)
    const sizeBefore = data.size
    const id2 = await store(CID.parse(id), provider)
    expect(id2).toBe(id)
    expect(data.size).toBe(sizeBefore)
  })
})

// ============================================================
// load — returns AssetValue with AssetLinks inline (no resolve)
// ============================================================

describe('load — preserves CID links inline', () => {
  it('returns a stored object verbatim when no links are embedded', async () => {
    const { provider } = makeMemoryStore()
    const value = { a: 1, b: { c: 2 } }
    const id = await store(value, provider)
    const loaded = await load(id, provider)
    expect(loaded).toEqual(value)
  })

  it('returns a stored Uint8Array verbatim', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([5, 6, 7])
    const id = await store(buf, provider)
    const loaded = await load(id, provider)
    expect(loaded).toBeInstanceOf(Uint8Array)
    expect(loaded).toEqual(buf)
  })

  it('does NOT recursively follow embedded links — caller must call resolve()', async () => {
    const { provider } = makeMemoryStore()
    const inner = { x: 1 }
    const innerId = await store(inner, provider)
    const wrapper = { ref: CID.parse(innerId) }
    const wrapperId = await store(wrapper, provider)
    const loaded = await load(wrapperId, provider)
    expect(loaded).not.toBeNull()
    expect(typeof loaded).toBe('object')
    // The link is preserved as a CID instance — NOT pre-resolved.
    const cid = CID.asCID((loaded as { ref: unknown }).ref)
    expect(cid).not.toBeNull()
  })
})

// ============================================================
// resolve — full materialization
// ============================================================

describe('resolve — full materialization', () => {
  it('CID link to raw data resolves to Uint8Array', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([5, 6, 7])
    const id = await store(buf, provider)
    const result = await resolve(CID.parse(id), provider)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result).toEqual(buf)
  })

  it('CID link to compound resolves recursively', async () => {
    const { provider } = makeMemoryStore()
    const id = await store({ val: 42 }, provider)
    const result = await resolve(CID.parse(id), provider)
    expect(result).toEqual({ val: 42 })
  })

  it('CID link to array resolves recursively', async () => {
    const { provider } = makeMemoryStore()
    const arr: AssetValue = [1, 2, 3]
    const id = await store(arr, provider)
    const result = await resolve(CID.parse(id), provider)
    expect(result).toEqual([1, 2, 3])
  })

  it('resolves explicit CID chain: object → explicitly stored binary', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([1, 2])
    const bufId = await store(buf, provider)
    const objId = await store({ data: CID.parse(bufId) }, provider)
    const loaded = await load(objId, provider)
    const resolved = await resolve(loaded, provider)
    expect(resolved).toEqual({ data: new Uint8Array([1, 2]) })
  })

  it('primitives and inline Uint8Array pass through unchanged', async () => {
    const { provider } = makeMemoryStore()
    const v1 = await resolve(42 as unknown as AssetValue, provider)
    expect(v1).toBe(42)
    const v2 = await resolve(null, provider)
    expect(v2).toBeNull()
    const v3 = await resolve('hello' as unknown as AssetValue, provider)
    expect(v3).toBe('hello')
    const buf = new Uint8Array([9])
    const v4 = await resolve(buf, provider)
    expect(v4).toBe(buf)
  })

  it('round-trip with explicit links: store sub-objects then resolve parent', async () => {
    const { provider } = makeMemoryStore()
    const buf = new Uint8Array([1, 2, 3])
    const bufId = await store(buf, provider)
    const config = { k: 'v' }
    const configId = await store(config, provider)
    const list: AssetValue = [1, 2]
    const listId = await store(list, provider)
    const parent = {
      data: CID.parse(bufId),
      config: CID.parse(configId),
      list: CID.parse(listId),
    }
    const parentId = await store(parent, provider)
    const loaded = await load(parentId, provider)
    const resolved = await resolve(loaded, provider)
    expect(resolved).toEqual({ data: buf, config, list })
  })

  it('idempotent on already-resolved plain object', async () => {
    const { provider } = makeMemoryStore()
    const v = { a: 1, b: 'str' }
    const result = await resolve(v, provider)
    expect(result).toEqual(v)
  })
})
