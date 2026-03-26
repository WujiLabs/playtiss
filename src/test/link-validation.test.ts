import * as dagCBOR from '@ipld/dag-cbor'
import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { sha512 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { isAssetId } from '../types/asset_id.js'
import { isLink } from '../types/asset_value.js'

describe('isAssetId', () => {
  it('accepts dag-json + sha256 CID string', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagJSON, hasher: sha256 })
    expect(isAssetId(block.cid.toString())).toBe(true)
  })

  it('accepts raw + sha256 CID string', async () => {
    const block = await Block.encode({ value: new Uint8Array([1, 2, 3]), codec: raw, hasher: sha256 })
    expect(isAssetId(block.cid.toString())).toBe(true)
  })

  it('rejects dag-cbor + sha256 CID string', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagCBOR, hasher: sha256 })
    expect(isAssetId(block.cid.toString())).toBe(false)
  })

  it('rejects dag-json + sha512 CID string', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagJSON, hasher: sha512 })
    expect(isAssetId(block.cid.toString())).toBe(false)
  })

  it('rejects random strings', () => {
    expect(isAssetId('not-a-cid')).toBe(false)
    expect(isAssetId('')).toBe(false)
  })
})

describe('isLink', () => {
  it('accepts dag-json + sha256 CID object', async () => {
    const block = await Block.encode({ value: { x: 1 }, codec: dagJSON, hasher: sha256 })
    expect(isLink(block.cid)).toBe(true)
  })

  it('accepts raw + sha256 CID object', async () => {
    const block = await Block.encode({ value: new Uint8Array([42]), codec: raw, hasher: sha256 })
    expect(isLink(block.cid)).toBe(true)
  })

  it('rejects dag-cbor CID object', async () => {
    const block = await Block.encode({ value: { x: 1 }, codec: dagCBOR, hasher: sha256 })
    expect(isLink(block.cid)).toBe(false)
  })

  it('rejects sha512 CID object', async () => {
    const block = await Block.encode({ value: { x: 1 }, codec: dagJSON, hasher: sha512 })
    expect(isLink(block.cid)).toBe(false)
  })

  it('rejects non-CID values', () => {
    expect(isLink(null)).toBe(false)
    expect(isLink('string')).toBe(false)
    expect(isLink(42)).toBe(false)
    expect(isLink({})).toBe(false)
  })
})
