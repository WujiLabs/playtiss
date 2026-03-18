// Copyright (c) 2026 Wuji Labs Inc
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as dagJSON from '@ipld/dag-json'
import { describe, it, expect } from 'vitest'
import { computeHash } from '../asset-store/compute_hash.js'
import { isAssetId } from '../types/asset_id.js'

describe('computeHash', () => {
  it('returns a valid CID string for objects', async () => {
    const id = await computeHash({ foo: 'bar' })
    expect(isAssetId(id)).toBe(true)
    const cid = CID.parse(id)
    expect(cid.version).toBe(1)
    expect(cid.code).toBe(dagJSON.code) // dag-json codec 0x0129
  })

  it('returns a valid CID string for binary', async () => {
    const id = await computeHash(new Uint8Array([1, 2, 3]))
    expect(isAssetId(id)).toBe(true)
    const cid = CID.parse(id)
    expect(cid.version).toBe(1)
    expect(cid.code).toBe(raw.code) // raw codec 0x55
  })

  it('is deterministic for the same input', async () => {
    const id1 = await computeHash({ a: 1, b: 'hello' })
    const id2 = await computeHash({ a: 1, b: 'hello' })
    expect(id1).toBe(id2)
  })

  it('is key-order independent (dag-json sorts keys)', async () => {
    const id1 = await computeHash({ a: 1, b: 2 })
    const id2 = await computeHash({ b: 2, a: 1 })
    expect(id1).toBe(id2)
  })

  it('produces different CIDs for different objects', async () => {
    const id1 = await computeHash({ x: 1 })
    const id2 = await computeHash({ x: 2 })
    expect(id1).not.toBe(id2)
  })

  it('produces different CIDs for binary vs object with same content shape', async () => {
    const bytes = new TextEncoder().encode('hello')
    const id1 = await computeHash(bytes)
    const id2 = await computeHash({ data: 'hello' })
    expect(id1).not.toBe(id2)
    // Verify codecs differ
    expect(CID.parse(id1).code).toBe(raw.code)
    expect(CID.parse(id2).code).toBe(dagJSON.code)
  })

  it('empty object has a stable CID', async () => {
    const id = await computeHash({})
    expect(isAssetId(id)).toBe(true)
    // Verify it's consistent
    expect(await computeHash({})).toBe(id)
  })
})
