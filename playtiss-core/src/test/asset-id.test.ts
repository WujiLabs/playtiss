// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as dagCBOR from '@ipld/dag-cbor'
import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import * as raw from 'multiformats/codecs/raw'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { isAssetId } from '../asset-id.js'

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

  it('rejects empty string', () => {
    expect(isAssetId('')).toBe(false)
  })

  it('rejects random strings', () => {
    expect(isAssetId('not-a-cid')).toBe(false)
    expect(isAssetId('deadbeef')).toBe(false)
  })
})
