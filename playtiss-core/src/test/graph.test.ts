// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'

import type { Graph, GraphEdge, GraphNode } from '../graph.js'
import { computeHash } from '../hash.js'
import { generateTraceId, type TraceId } from '../trace-id.js'

describe('Graph primitives — content addressing', () => {
  it('hashes an empty graph to a stable CID', async () => {
    const empty: Graph = { nodes: {}, edges: {} }
    const id1 = await computeHash(empty)
    const id2 = await computeHash({ nodes: {}, edges: {} })
    expect(id1).toBe(id2)
  })

  it('different nodes → different CIDs', async () => {
    const nodeA: GraphNode = { action: 'foo' }
    const nodeB: GraphNode = { action: 'bar' }
    const idA = generateTraceId()
    const idB = generateTraceId()
    const graphA: Graph = { nodes: { [idA]: nodeA }, edges: {} }
    const graphB: Graph = { nodes: { [idB]: nodeB }, edges: {} }
    expect(await computeHash(graphA)).not.toBe(await computeHash(graphB))
  })

  it('insertion-order independent (dag-json sorts keys)', async () => {
    const id1 = generateTraceId()
    const id2 = generateTraceId()
    const nodes1 = { [id1]: { action: 'a' }, [id2]: { action: 'b' } } as Record<TraceId, GraphNode>
    const nodes2 = { [id2]: { action: 'b' }, [id1]: { action: 'a' } } as Record<TraceId, GraphNode>
    const graphA: Graph = { nodes: nodes1, edges: {} }
    const graphB: Graph = { nodes: nodes2, edges: {} }
    expect(await computeHash(graphA)).toBe(await computeHash(graphB))
  })
})

describe('GraphEdge shape', () => {
  it('accepts source=null (graph input boundary)', () => {
    const target = generateTraceId()
    const edge: GraphEdge = {
      source: null,
      target,
      sourceHandle: 'input_a',
      targetHandle: 'x',
    }
    expect(edge.source).toBeNull()
    expect(edge.target).toBe(target)
  })

  it('accepts target=null (graph output boundary)', () => {
    const source = generateTraceId()
    const edge: GraphEdge = {
      source,
      target: null,
      sourceHandle: 'out',
      targetHandle: 'output_y',
    }
    expect(edge.target).toBeNull()
  })

  it('accepts null-null pass-through edge (graph input directly to output)', async () => {
    const edge: GraphEdge = {
      source: null,
      target: null,
      sourceHandle: 'in',
      targetHandle: 'out',
    }
    // Consumers may reject this; core allows it as a valid shape.
    const id = await computeHash(edge)
    expect(typeof id).toBe('string')
  })

  it('accepts null handles (default port)', () => {
    const source = generateTraceId()
    const target = generateTraceId()
    const edge: GraphEdge = {
      source,
      target,
      sourceHandle: null,
      targetHandle: null,
    }
    expect(edge.sourceHandle).toBeNull()
    expect(edge.targetHandle).toBeNull()
  })
})

describe('Graph with edges — CID stability', () => {
  it('same graph structure → same CID across producers', async () => {
    const n1 = generateTraceId()
    const n2 = generateTraceId()
    const e1 = generateTraceId()
    const node1: GraphNode = { action: 'op' }
    const node2: GraphNode = { action: 'op' }
    const edge: GraphEdge = {
      source: n1,
      target: n2,
      sourceHandle: 'output',
      targetHandle: 'input',
    }
    const graph: Graph = {
      nodes: { [n1]: node1, [n2]: node2 },
      edges: { [e1]: edge },
    }
    const id1 = await computeHash(graph)
    const id2 = await computeHash({
      // Different insertion order — should still hash identically
      edges: { [e1]: edge },
      nodes: { [n2]: node2, [n1]: node1 },
    })
    expect(id1).toBe(id2)
  })
})
