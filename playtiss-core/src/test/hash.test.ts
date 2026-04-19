// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as dagJSON from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { describe, expect, it } from 'vitest'

import { isAssetId } from '../asset-id.js'
import { cidToAssetId, computeHash, computeTopBlock } from '../hash.js'

describe('computeHash', () => {
  it('returns a valid CID string for objects', async () => {
    const id = await computeHash({ foo: 'bar' })
    expect(isAssetId(id)).toBe(true)
    const cid = CID.parse(id)
    expect(cid.version).toBe(1)
    expect(cid.code).toBe(dagJSON.code) // dag-json codec 0x0129
  })

  it('returns a valid CID string for binary (raw codec)', async () => {
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

  it('is key-order independent (dag-json sorts keys per spec)', async () => {
    const id1 = await computeHash({ a: 1, b: 2 })
    const id2 = await computeHash({ b: 2, a: 1 })
    expect(id1).toBe(id2)
  })

  it('produces different CIDs for different objects', async () => {
    const id1 = await computeHash({ x: 1 })
    const id2 = await computeHash({ x: 2 })
    expect(id1).not.toBe(id2)
  })

  it('hashes primitives (null)', async () => {
    const id = await computeHash(null)
    expect(isAssetId(id)).toBe(true)
  })

  it('hashes primitives (boolean)', async () => {
    const tId = await computeHash(true)
    const fId = await computeHash(false)
    expect(tId).not.toBe(fId)
  })

  it('hashes primitives (number)', async () => {
    const id1 = await computeHash(42)
    const id2 = await computeHash(42)
    expect(id1).toBe(id2)
    const id3 = await computeHash(43)
    expect(id1).not.toBe(id3)
  })

  it('hashes empty object and empty array differently', async () => {
    const objId = await computeHash({})
    const arrId = await computeHash([])
    expect(objId).not.toBe(arrId)
  })

  it('passes CID input through unchanged', async () => {
    const block = await computeTopBlock({ marker: 'source' })
    const cidInput = block.cid
    const roundTripped = await computeHash(cidInput)
    expect(roundTripped).toBe(cidToAssetId(cidInput))
  })

  it('Merkle-izes nested objects (same content → same CID regardless of nesting)', async () => {
    const inner = { name: 'widget' }
    const outerInline = { item: inner }
    const outerLinked = { item: await computeHash(inner) }
    // These encode differently at the wire (CID link vs inline object) but because
    // computeHash flattens sub-objects to CIDs, the top-level hash is identical.
    const idInline = await computeHash(outerInline)
    const idLinked = await computeHash({ item: CID.parse(await computeHash(inner)) })
    expect(idInline).toBe(idLinked)
    // Sanity: directly-linked form differs (it's a string, not a CID)
    const idStringLinked = await computeHash(outerLinked)
    expect(idInline).not.toBe(idStringLinked)
  })
})

describe('computeTopBlock', () => {
  it('returns cid, bytes, and flatValue for an object', async () => {
    const block = await computeTopBlock({ a: 1, b: 'hello' })
    expect(block.cid).toBeInstanceOf(CID)
    expect(block.bytes).toBeInstanceOf(Uint8Array)
    expect(block.flatValue).toEqual({ a: 1, b: 'hello' }) // no nesting to flatten
  })

  it('returns raw-codec CID for binary input', async () => {
    const block = await computeTopBlock(new Uint8Array([1, 2, 3]))
    expect(block.cid.code).toBe(raw.code)
  })
})

describe('cidToAssetId', () => {
  it('stringifies a CID', async () => {
    const block = await computeTopBlock({ ok: true })
    const id = cidToAssetId(block.cid)
    expect(typeof id).toBe('string')
    expect(isAssetId(id)).toBe(true)
  })
})
