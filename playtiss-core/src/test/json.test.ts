// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'

import { decodeFromString, encodeToString } from '../json.js'

describe('encodeToString / decodeFromString', () => {
  it('roundtrips an empty object', () => {
    const s = encodeToString({})
    expect(decodeFromString(s)).toEqual({})
  })

  it('roundtrips nested objects', () => {
    const value = { a: 1, b: 'hello', c: { d: [1, 2, 3], e: null } }
    const s = encodeToString(value)
    expect(decodeFromString(s)).toEqual(value)
  })

  it('produces canonical output: keys sorted by dag-json spec', () => {
    // The spec mandates that encoded keys appear in UTF-8 byte order.
    const sA = encodeToString({ a: 1, b: 2 })
    const sB = encodeToString({ b: 2, a: 1 })
    expect(sA).toBe(sB)
  })

  it('strips whitespace (dag-json canonical form)', () => {
    const s = encodeToString({ a: 1 })
    expect(s).not.toContain(' ')
    expect(s).not.toContain('\n')
  })

  it('roundtrips Uint8Array (dag-json bytes link)', () => {
    const original = new Uint8Array([1, 2, 3])
    const s = encodeToString(original)
    // dag-json encodes Uint8Array as {"/": {"bytes": "base64pad..."}}
    expect(s).toContain('"/"')
    expect(s).toContain('"bytes"')
    // And decodes it back to a Uint8Array
    const decoded = decodeFromString(s)
    expect(decoded).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded as Uint8Array)).toEqual([1, 2, 3])
  })

  it('preserves primitives (string, number, boolean, null)', () => {
    expect(decodeFromString(encodeToString('hello'))).toBe('hello')
    expect(decodeFromString(encodeToString(42))).toBe(42)
    expect(decodeFromString(encodeToString(true))).toBe(true)
    expect(decodeFromString(encodeToString(null))).toBe(null)
  })
})
