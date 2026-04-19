// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as dagCBOR from '@ipld/dag-cbor'
import * as dagJSON from '@ipld/dag-json'
import * as Block from 'multiformats/block'
import * as raw from 'multiformats/codecs/raw'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { isLink } from '../asset-value.js'

describe('isLink', () => {
  it('accepts dag-json + sha256 CID object', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagJSON, hasher: sha256 })
    expect(isLink(block.cid)).toBe(true)
  })

  it('accepts raw + sha256 CID object', async () => {
    const block = await Block.encode({ value: new Uint8Array([1, 2, 3]), codec: raw, hasher: sha256 })
    expect(isLink(block.cid)).toBe(true)
  })

  it('rejects dag-cbor + sha256 CID', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagCBOR, hasher: sha256 })
    expect(isLink(block.cid)).toBe(false)
  })

  it('rejects dag-json + sha512 CID', async () => {
    const block = await Block.encode({ value: { hello: 'world' }, codec: dagJSON, hasher: sha512 })
    expect(isLink(block.cid)).toBe(false)
  })

  it('rejects plain string', () => {
    expect(isLink('bafyreibmrms...')).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(isLink(null)).toBe(false)
    expect(isLink(undefined)).toBe(false)
  })

  it('rejects plain objects', () => {
    expect(isLink({})).toBe(false)
    expect(isLink({ '/': 'string' })).toBe(false)
  })
})
