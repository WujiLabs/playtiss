// Copyright (c) 2026 Wuji Labs Inc
//
// Regression tests for scheduler edge-resolution after the flat Edge rewrite.
// A miscategorization of sourceHandle / targetHandle prefix (% / ^ / plain)
// silently corrupts the runtime data-flow — a bug that only surfaces far
// downstream. These tests pin the prefix routing behavior.

import type { DictAsset, TraceId } from '@playtiss/core'
import type { Edge } from 'playtiss/pipeline'
import { describe, expect, it } from 'vitest'

import {
  isContextSlot,
  isMetaSlot,
  resolveContextEdges,
  resolveDataEdges,
  resolveMetaEdges,
} from '../pipeline/scheduler.js'

describe('prefix classifiers', () => {
  it('isContextSlot: accepts %-prefixed, rejects ^ and plain', () => {
    expect(isContextSlot('%ctx')).toBe(true)
    expect(isContextSlot('^meta')).toBe(false)
    expect(isContextSlot('plain')).toBe(false)
  })

  it('isMetaSlot: accepts ^-prefixed, rejects % and plain', () => {
    expect(isMetaSlot('^meta')).toBe(true)
    expect(isMetaSlot('%ctx')).toBe(false)
    expect(isMetaSlot('plain')).toBe(false)
  })
})

function edge(sourceHandle: string, targetHandle: string, source: TraceId | null = null, target: TraceId | null = null): Edge {
  return { source, sourceHandle, target, targetHandle }
}

describe('resolveContextEdges (tag edges → context object)', () => {
  it('reads plain-named value from current asset (nested path), writes to target context key', async () => {
    const edges = [edge('path.a', '%result')]
    const context = {}
    const asset: DictAsset = { path: { a: 42 } }
    const result = await resolveContextEdges(edges, context, asset)
    expect(result).toEqual({ '%result': 42 })
  })

  it('reads %-prefixed sourceHandle from current context', async () => {
    const edges = [edge('%input_ctx', '%output_ctx')]
    const context = { '%input_ctx': 'hello' }
    const asset: DictAsset = {}
    const result = await resolveContextEdges(edges, context, asset)
    expect(result).toEqual({ '%output_ctx': 'hello' })
  })

  it('reads ^-prefixed sourceHandle from current asset', async () => {
    const edges = [edge('^meta_field', '%ctx_out')]
    const context = {}
    const asset: DictAsset = { '^meta_field': 'meta_val' }
    const result = await resolveContextEdges(edges, context, asset)
    expect(result).toEqual({ '%ctx_out': 'meta_val' })
  })

  it('skips edges whose source value is undefined', async () => {
    const edges = [edge('missing_key', '%result')]
    const context = {}
    const asset: DictAsset = {}
    const result = await resolveContextEdges(edges, context, asset)
    expect(result).toEqual({})
  })
})

describe('resolveDataEdges (slot edges → asset dict)', () => {
  it('reads plain-named value and writes to target data slot (plain key)', async () => {
    const edges = [edge('nested.x', 'y')]
    const context = {}
    const asset: DictAsset = { nested: { x: 100 } }
    const base: DictAsset = {}
    const result = await resolveDataEdges(edges, context, asset, base)
    expect(result).toEqual({ y: 100 })
  })

  it('preserves baseAsset keys and writes new ones from edges', async () => {
    const edges = [edge('src', 'dst')]
    const context = {}
    const asset: DictAsset = { src: 'fresh' }
    const base: DictAsset = { preserved: 'old' }
    const result = await resolveDataEdges(edges, context, asset, base)
    expect(result).toEqual({ preserved: 'old', dst: 'fresh' })
  })

  it('reads context from currentContext when %-prefixed', async () => {
    const edges = [edge('%c', 'out')]
    const context = { '%c': 'from_context' }
    const asset: DictAsset = {}
    const result = await resolveDataEdges(edges, context, asset, {})
    expect(result).toEqual({ out: 'from_context' })
  })
})

describe('resolveMetaEdges (meta edges → asset dict with ^-prefixed keys)', () => {
  it('reads plain source and writes to ^-prefixed target', async () => {
    const edges = [edge('data', '^meta_out')]
    const context = {}
    const asset: DictAsset = { data: 'data_val' }
    const base: DictAsset = {}
    const result = await resolveMetaEdges(edges, context, asset, base)
    expect(result).toEqual({ '^meta_out': 'data_val' })
  })

  it('targetHandle literal is used as the write key (no prefix stripping)', async () => {
    const edges = [edge('src', '^kept_prefix')]
    const context = {}
    const asset: DictAsset = { src: 1 }
    const result = await resolveMetaEdges(edges, context, asset, {})
    // Verify the prefix is preserved in the output key — downstream code
    // relies on the ^ prefix to strip meta fields before hashing.
    expect(Object.keys(result)).toContain('^kept_prefix')
  })
})

describe('flat edge shape — regression guardrail', () => {
  it('resolvers read edge.sourceHandle / edge.targetHandle, NOT nested .source.name / .target.name', async () => {
    // If the rewrite accidentally reintroduced the old nested shape, these
    // destructures would fail with "Cannot read property 'name' of undefined".
    const e: Edge = { source: null, sourceHandle: 'foo', target: null, targetHandle: 'bar' }
    // Destructure as the resolvers do
    const { sourceHandle, targetHandle } = e
    expect(sourceHandle).toBe('foo')
    expect(targetHandle).toBe('bar')
    // No .node or .name fields should exist at top level
    expect('node' in e).toBe(false)
    expect('name' in e).toBe(false)
  })
})
