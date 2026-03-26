// Copyright (c) 2026 Wuji Labs Inc
import * as dagJSON from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { beforeEach, describe, expect, it } from 'vitest'

import { computeHash } from '../asset-store/compute_hash.js'
import { setCustomStorageProvider } from '../asset-store/index.js'
import { load, resolve, store } from '../asset-store/index.js'
import type { StorageProvider } from '../asset-store/storage-provider.js'
import type { AssetId, AssetValue } from '../index.js'

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

beforeEach(() => {
  const { provider } = makeMemoryStore()
  setCustomStorageProvider(provider)
})

// ============================================================
// computeHash — pure Merkle tests (no storage needed)
// ============================================================

describe('computeHash — Merkle-ization (pure)', () => {
  it('binary input uses raw codec', async () => {
    const id = await computeHash(new Uint8Array([1, 2, 3]))
    const cid = CID.parse(id)
    expect(cid.code).toBe(raw.code)
  })

  it('object input uses dag-json codec', async () => {
    const id = await computeHash({ x: 1 })
    const cid = CID.parse(id)
    expect(cid.code).toBe(dagJSON.code)
  })

  it('inline binary and CID link to same binary produce equal hashes', async () => {
    const buf = new Uint8Array([10, 20, 30])
    const bufCid = CID.parse(await computeHash(buf))
    const id1 = await computeHash({ data: buf })
    const id2 = await computeHash({ data: bufCid })
    expect(id1).toBe(id2)
  })

  it('inline nested object and CID link to same object produce equal hashes', async () => {
    const inner = { x: 1 }
    const innerCid = CID.parse(await computeHash(inner))
    const id1 = await computeHash({ config: inner })
    const id2 = await computeHash({ config: innerCid })
    expect(id1).toBe(id2)
  })

  it('inline array and CID link to same array produce equal hashes', async () => {
    const arr: AssetValue = [1, 2, 3]
    const arrCid = CID.parse(await computeHash(arr))
    const id1 = await computeHash({ items: arr })
    const id2 = await computeHash({ items: arrCid })
    expect(id1).toBe(id2)
  })

  it('array itself computes a CID', async () => {
    const id = await computeHash([1, 2, 3])
    const cid = CID.parse(id)
    expect(cid.version).toBe(1)
    expect(cid.code).toBe(dagJSON.code)
  })

  it('key-order independence preserved after Merkle-ization', async () => {
    const id1 = await computeHash({ a: 1, b: 2 })
    const id2 = await computeHash({ b: 2, a: 1 })
    expect(id1).toBe(id2)
  })

  it('is deterministic', async () => {
    const id1 = await computeHash({ nested: { val: 42 } })
    const id2 = await computeHash({ nested: { val: 42 } })
    expect(id1).toBe(id2)
  })

  it('computeHash is pure — does not call storage', async () => {
    let storageCalled = false
    const spy: StorageProvider = {
      async hasBuffer() {
        storageCalled = true
        return false
      },
      async fetchBuffer() {
        storageCalled = true
        return new Uint8Array()
      },
      async saveBuffer() { storageCalled = true },
    }
    setCustomStorageProvider(spy)
    const id = await computeHash({ pure: true, nested: { val: 1 } })
    expect(CID.parse(id).version).toBe(1)
    expect(storageCalled).toBe(false)
    // Restore memory provider for subsequent tests in this suite
    const { provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
  })
})

// ============================================================
// store — deduplication tests
// ============================================================

describe('store — Merkle deduplication', () => {
  it('binary: store({data: buf}) === store({data: CID(buf)})', async () => {
    const buf = new Uint8Array([1, 2, 3])
    const bufId = await store(buf)
    const id1 = await store({ data: buf })
    const id2 = await store({ data: CID.parse(bufId) })
    expect(id1).toBe(id2)
  })

  it('compound: store({config: {x:1}}) === store({config: CID({x:1})})', async () => {
    const inner = { x: 1 }
    const innerId = await store(inner)
    const id1 = await store({ config: inner })
    const id2 = await store({ config: CID.parse(innerId) })
    expect(id1).toBe(id2)
  })

  it('array: store({items: [1,2,3]}) === store({items: CID([1,2,3])})', async () => {
    const arr: AssetValue = [1, 2, 3]
    const arrId = await store(arr)
    const id1 = await store({ items: arr })
    const id2 = await store({ items: CID.parse(arrId) })
    expect(id1).toBe(id2)
  })

  it('deep nested dedup: {outer: {inner: buf}} vs {outer: CID({inner: CID(buf)})}', async () => {
    const buf = new Uint8Array([7, 8, 9])
    const bufId = await store(buf)
    const innerObj = { inner: buf }
    const innerId = await store(innerObj)
    const id1 = await store({ outer: innerObj })
    const id2 = await store({ outer: CID.parse(innerId) })
    // Both representations lead to same top-level CID
    expect(id1).toBe(id2)
    // Also verify the fully-linked form
    const innerLinked = { inner: CID.parse(bufId) }
    const id3 = await store({ outer: innerLinked })
    expect(id1).toBe(id3)
  })

  it('is idempotent: same input stored twice returns same CID', async () => {
    const { data, provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const id1 = await store({ a: 1 })
    const sizeBefore = data.size
    const id2 = await store({ a: 1 })
    expect(id1).toBe(id2)
    expect(data.size).toBe(sizeBefore)
  })

  it('top-level binary produces raw codec CID', async () => {
    const id = await store(new Uint8Array([42]))
    expect(CID.parse(id).code).toBe(raw.code)
  })

  it('top-level object produces dag-json codec CID', async () => {
    const id = await store({ foo: 'bar' })
    expect(CID.parse(id).code).toBe(dagJSON.code)
  })

  it('stored block has no nested objects — only primitives and CIDs', async () => {
    const { data, provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    // store() persists exactly one block; its bytes encode a flat structure
    await store({ a: { b: 1 }, c: [2, 3] })
    expect(data.size).toBe(1) // single block
    const [bytes] = [...data.values()]
    const decoded = dagJSON.decode(bytes) as Record<string, unknown>
    // Each value in the stored block is a CID (sub-objects/arrays are CID-linked)
    for (const v of Object.values(decoded)) {
      expect(v instanceof CID).toBe(true)
    }
  })

  it('store() produces exactly one block per call (O(1) I/O)', async () => {
    const { data, provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const inner = { val: 99 }
    await store({ a: inner, b: inner })
    expect(data.size).toBe(1)
  })

  it('CID input returns the CID string without additional storage', async () => {
    const { data, provider } = makeMemoryStore()
    setCustomStorageProvider(provider)
    const buf = new Uint8Array([1])
    const id = await store(buf)
    const sizeBefore = data.size
    const id2 = await store(CID.parse(id))
    expect(id2).toBe(id)
    expect(data.size).toBe(sizeBefore)
  })
})

// ============================================================
// resolve — materialization tests
// ============================================================

describe('resolve — full materialization', () => {
  it('CID link to raw data resolves to Uint8Array', async () => {
    const buf = new Uint8Array([5, 6, 7])
    const id = await store(buf)
    const result = await resolve(CID.parse(id))
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result).toEqual(buf)
  })

  it('CID link to compound resolves recursively', async () => {
    const id = await store({ val: 42 })
    const result = await resolve(CID.parse(id))
    expect(result).toEqual({ val: 42 })
  })

  it('CID link to array resolves recursively', async () => {
    const arr: AssetValue = [1, 2, 3]
    const id = await store(arr)
    const result = await resolve(CID.parse(id))
    expect(result).toEqual([1, 2, 3])
  })

  it('resolves explicit CID chain: object → explicitly stored binary', async () => {
    // Sub-objects that are explicitly stored independently can be resolved
    const buf = new Uint8Array([1, 2])
    const bufId = await store(buf)
    // Store the object with an explicit CID link (not inline)
    const objId = await store({ data: CID.parse(bufId) })
    const loaded = await load(objId)
    const resolved = await resolve(loaded)
    expect(resolved).toEqual({ data: new Uint8Array([1, 2]) })
  })

  it('primitives and inline Uint8Array pass through unchanged', async () => {
    const v1 = await resolve(42 as unknown as AssetValue)
    expect(v1).toBe(42)
    const v2 = await resolve(null)
    expect(v2).toBeNull()
    const v3 = await resolve('hello' as unknown as AssetValue)
    expect(v3).toBe('hello')
    const buf = new Uint8Array([9])
    const v4 = await resolve(buf)
    expect(v4).toBe(buf)
  })

  it('round-trip with explicit links: store sub-objects then resolve parent', async () => {
    // Build a structure where sub-objects are explicitly stored and linked
    const buf = new Uint8Array([1, 2, 3])
    const bufId = await store(buf)
    const config = { k: 'v' }
    const configId = await store(config)
    const list: AssetValue = [1, 2]
    const listId = await store(list)
    const parent = {
      data: CID.parse(bufId),
      config: CID.parse(configId),
      list: CID.parse(listId),
    }
    const parentId = await store(parent)
    const loaded = await load(parentId)
    const resolved = await resolve(loaded)
    expect(resolved).toEqual({ data: buf, config, list })
  })

  it('idempotent on already-resolved plain object', async () => {
    const v = { a: 1, b: 'str' }
    const result = await resolve(v)
    expect(result).toEqual(v)
  })
})
