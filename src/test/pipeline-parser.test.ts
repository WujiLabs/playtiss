// Copyright (c) 2026 Wuji Labs Inc
//
// Regression tests for the pipeline parser after the flat Edge rewrite.
// Exercises buildAdjacency / classifyNodeTypes / buildDownstreamMap /
// extractSlotNames through the public parsePipeline API.
import type { AssetId, StorageProvider, TraceId, UserActionId } from '@playtiss/core'
import { generateTraceId } from '@playtiss/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { setCustomStorageProvider, store } from '../asset-store/index.js'
import type { Edge, Node, Pipeline } from '../pipeline/index.js'
import { parsePipeline } from '../pipeline/parser.js'

function makeMemoryStore(): StorageProvider {
  const data = new Map<string, Uint8Array>()
  return {
    async hasBuffer(id: AssetId) { return data.has(id) },
    async fetchBuffer(id: AssetId) {
      const buf = data.get(id)
      if (!buf) throw new Error(`Not found: ${id}`)
      return buf
    },
    async saveBuffer(buffer: Uint8Array, id: AssetId) { data.set(id, buffer) },
  }
}

beforeEach(() => {
  setCustomStorageProvider(makeMemoryStore())
})

// Helper: build a Pipeline with the given nodes and edges, store it,
// and return its AssetId for parsePipeline.
async function buildAndStore(nodes: Record<TraceId, Node>, edges: Record<TraceId, Edge>): Promise<AssetId> {
  const pipeline: Pipeline = {
    description: 'test',
    input_schema: {},
    output_schema: {},
    nodes,
    edges,
  }
  return store(pipeline)
}

describe('parsePipeline — node classification', () => {
  it('classifies a single regular node', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: null, sourceHandle: 'in', target: n, targetHandle: 'in' },
        [generateTraceId()]: { source: n, sourceHandle: 'out', target: null, targetHandle: 'out' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.node_types[n]).toBe('regular')
    expect(info.output_type).toBe('regular')
  })

  it('classifies builtins: split / merge / const', async () => {
    const s = generateTraceId()
    const m = generateTraceId()
    const c = generateTraceId()
    const id = await buildAndStore(
      {
        [s]: { action: 'split' },
        [m]: { action: 'merge' },
        [c]: { action: 'const', value: { x: 1 } },
      },
      {}, // zero edges — fine for classification test
    )
    const info = await parsePipeline(id)
    expect(info.node_types[s]).toBe('task_split')
    expect(info.node_types[m]).toBe('task_merge')
    expect(info.node_types[c]).toBe('const')
  })

  it('promotes a regular node with multiple distinct sources to "merge"', async () => {
    const a = generateTraceId()
    const b = generateTraceId()
    const target = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      {
        [a]: { action },
        [b]: { action },
        [target]: { action },
      },
      {
        [generateTraceId()]: { source: a, sourceHandle: 'out', target, targetHandle: 'left' },
        [generateTraceId()]: { source: b, sourceHandle: 'out', target, targetHandle: 'right' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.node_types[target]).toBe('merge')
    expect(info.node_types[a]).toBe('regular')
    expect(info.node_types[b]).toBe('regular')
  })

  it('classifies pipeline output as "merge" when fed by multiple sources', async () => {
    const a = generateTraceId()
    const b = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [a]: { action }, [b]: { action } },
      {
        [generateTraceId()]: { source: a, sourceHandle: 'out', target: null, targetHandle: 'result' },
        [generateTraceId()]: { source: b, sourceHandle: 'out', target: null, targetHandle: 'extra' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.output_type).toBe('merge')
  })
})

describe('parsePipeline — handle prefix classification', () => {
  it('routes % prefix to context (not tracked in node_slots or node_meta_slots)', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: null, sourceHandle: 'in', target: n, targetHandle: '%ctx' },
      },
    )
    const info = await parsePipeline(id)
    // Context slots are NOT included in node_slots or node_meta_slots.
    expect(info.node_slots[n]).toBeUndefined()
    expect(info.node_meta_slots[n]).toBeUndefined()
  })

  it('routes ^ prefix to node_meta_slots', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: null, sourceHandle: 'in', target: n, targetHandle: '^meta' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.node_meta_slots[n]).toEqual(['^meta'])
    expect(info.node_slots[n]).toBeUndefined()
  })

  it('routes plain names to node_slots (data slots, tracked for merge readiness)', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: null, sourceHandle: 'in', target: n, targetHandle: 'a' },
        [generateTraceId()]: { source: null, sourceHandle: 'in2', target: n, targetHandle: 'b' },
      },
    )
    const info = await parsePipeline(id)
    expect(new Set(info.node_slots[n])).toEqual(new Set(['a', 'b']))
  })
})

describe('parsePipeline — pipeline-boundary edges', () => {
  it('partitions null-source edges into input_next, not downstreamMap', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: null, sourceHandle: 'input_a', target: n, targetHandle: 'a' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.input_next).toHaveLength(1)
    expect(info.input_next[0].node).toBe(n)
    expect(info.node_nexts).toEqual({})
  })

  it('collects null-target edges into output_slots', async () => {
    const n = generateTraceId()
    const action = generateTraceId() as UserActionId
    const id = await buildAndStore(
      { [n]: { action } },
      {
        [generateTraceId()]: { source: n, sourceHandle: 'out', target: null, targetHandle: 'result' },
      },
    )
    const info = await parsePipeline(id)
    expect(info.output_slots).toEqual(['result'])
  })
})
