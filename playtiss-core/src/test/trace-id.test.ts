// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  generateOperationId,
  generateTraceId,
  generateTraceIdBytes,
  isTraceId,
  parseTraceId,
  type TraceId,
  TraceIdGenerator,
} from '../trace-id.js'

describe('generateTraceId', () => {
  it('produces a 36-char UUID-format string', () => {
    const id = generateTraceId()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(36)
  })

  it('produces IDs recognizable by isTraceId', () => {
    const id = generateTraceId()
    expect(isTraceId(id)).toBe(true)
  })

  it('encodes UUID v8 (version bits = 8)', () => {
    const id = generateTraceId()
    // Group 3 of UUID is `8xxx` where 8 is the version nibble.
    const parts = id.split('-')
    expect(parts[2][0]).toBe('8')
  })

  it('encodes RFC 4122 variant (variant bits start with 8 in the nibble)', () => {
    const id = generateTraceId()
    const parts = id.split('-')
    // Group 4's first char encodes variant `10xx` (hex 8-b); our implementation
    // fixes the reserved bits to 00, so the high nibble is always 8.
    expect(parts[3][0]).toBe('8')
  })

  it('produces different IDs on each call (sequence increments)', () => {
    const gen = new TraceIdGenerator()
    const id1 = gen.generate()
    const id2 = gen.generate()
    expect(id1).not.toBe(id2)
  })
})

describe('parseTraceId', () => {
  it('roundtrips: parse(generate()) recovers timestamp and operationId', () => {
    const opId = new Uint8Array([1, 2, 3, 4, 5, 6])
    const before = Date.now()
    const id = generateTraceId(opId)
    const after = Date.now()
    const parsed = parseTraceId(id)
    expect(parsed.timestamp).toBeGreaterThanOrEqual(before)
    expect(parsed.timestamp).toBeLessThanOrEqual(after)
    expect(Array.from(parsed.operationId)).toEqual(Array.from(opId))
  })

  it('throws on invalid format', () => {
    expect(() => parseTraceId('not-a-uuid' as TraceId)).toThrow(/Invalid TraceID format/)
  })
})

describe('isTraceId', () => {
  it('accepts a freshly generated TraceId', () => {
    expect(isTraceId(generateTraceId())).toBe(true)
  })

  it('rejects non-string values', () => {
    expect(isTraceId(null)).toBe(false)
    expect(isTraceId(undefined)).toBe(false)
    expect(isTraceId(42)).toBe(false)
    expect(isTraceId({})).toBe(false)
  })

  it('rejects malformed strings', () => {
    expect(isTraceId('')).toBe(false)
    expect(isTraceId('not-a-uuid')).toBe(false)
    // UUID v4 (version = 4, not 8) — should be rejected
    expect(isTraceId('12345678-1234-4234-8234-123456789abc')).toBe(false)
  })
})

describe('TraceIdGenerator', () => {
  it('validates operationId length', () => {
    expect(() => new TraceIdGenerator(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('generateBytes returns a 16-byte buffer', () => {
    const bytes = generateTraceIdBytes()
    expect(bytes.byteLength).toBe(16)
  })

  it('shares a timestamp across all IDs from one generator', () => {
    const gen = new TraceIdGenerator()
    const ids = [gen.generate(), gen.generate(), gen.generate()]
    const timestamps = ids.map(id => parseTraceId(id).timestamp)
    expect(timestamps[0]).toBe(timestamps[1])
    expect(timestamps[1]).toBe(timestamps[2])
  })

  it('throws when sequence overflows 2^24', () => {
    const gen = new TraceIdGenerator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(gen as any).sequence = 2 ** 24 - 1
    expect(() => gen.generate()).toThrow(/Sequence number overflow/)
  })
})

describe('generateOperationId', () => {
  it('returns a 6-byte buffer', () => {
    expect(generateOperationId().byteLength).toBe(6)
  })

  it('produces distinct values across calls (cryptographic randomness)', () => {
    const a = generateOperationId()
    const b = generateOperationId()
    // 2^48 space — collision probability essentially zero
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})

describe('missing Web Crypto runtime', () => {
  const originalCrypto = (globalThis as { crypto?: unknown }).crypto
  beforeEach(() => {
    // Temporarily remove crypto from globalThis to simulate legacy runtime
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  })
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    })
  })

  it('throws a clear error instead of silently using Math.random', () => {
    expect(() => generateTraceId()).toThrow(/crypto\.getRandomValues is unavailable/)
  })
})
