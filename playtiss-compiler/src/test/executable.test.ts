// Copyright (c) 2026 Wuji Labs Inc
//
// Regression tests for toExecutable / tryStringify after the flat Edge rewrite.
// Verifies emitted edges have top-level source/sourceHandle/target/targetHandle
// (no nested {node, name} shape) and that const-node values survive the round-trip.
import type { UserActionId } from '@playtiss/core'
import { describe, expect, it } from 'vitest'

import { toExecutable, tryStringify } from '../executable.js'
import type { PFMNode, PFMWorkflow } from '../types.js'

function makeUserNode(section: string, actionId: string, params: Record<string, unknown> = {}): PFMNode {
  return {
    section,
    nodeName: `Node ${section}`,
    actionId,
    userActionId: ('019d9f37-9321-85a2-8bcc-' + actionId.padStart(12, '0')) as UserActionId,
    parameters: params,
    dependencies: [],
  } as PFMNode
}

describe('toExecutable — flat edge emission', () => {
  it('emits edges with top-level source/sourceHandle/target/targetHandle', async () => {
    const pfm: PFMWorkflow = {
      nodes: [
        makeUserNode('1', '1'),
        {
          section: '2',
          nodeName: 'Node 2',
          actionId: '2',
          userActionId: '019d9f37-9321-85a2-8bcc-000000000002' as UserActionId,
          parameters: {},
          dependencies: [
            { type: 'wikilink', nodeSection: '1', nodeName: 'Node 1', outputKey: 'result' },
          ],
        },
      ],
    }
    const pipeline = await toExecutable(pfm)
    const edges = Object.values(pipeline.edges)
    expect(edges).toHaveLength(1)
    const e = edges[0]
    // Flat shape — no nested {node, name}
    expect(typeof e.source === 'string' || e.source === null).toBe(true)
    expect(typeof e.target === 'string' || e.target === null).toBe(true)
    expect(typeof e.sourceHandle).toBe('string')
    expect(typeof e.targetHandle).toBe('string')
    // Nested shape must be absent (defensive — a stringified JSON check)
    expect(JSON.stringify(e)).not.toContain('"node"')
    expect(JSON.stringify(e)).not.toContain('"name"')
    expect(e.sourceHandle).toBe('result')
    expect(e.targetHandle).toBe('result')
  })

  it('emits builtin const nodes with the provided value', async () => {
    const pfm: PFMWorkflow = {
      nodes: [
        {
          section: '1',
          nodeName: 'Const 1',
          actionId: 'const',
          builtinAction: 'const',
          parameters: { value: { x: 42 } },
          dependencies: [],
        } as PFMNode,
      ],
    }
    const pipeline = await toExecutable(pfm)
    const nodes = Object.values(pipeline.nodes)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].action).toBe('const')
    // Const nodes must carry a value (ConstNode shape)
    expect((nodes[0] as { value?: unknown }).value).toEqual({ x: 42 })
  })

  it('emits zero edges when no dependencies are declared', async () => {
    const pfm: PFMWorkflow = {
      nodes: [makeUserNode('1', '1'), makeUserNode('2', '2')],
    }
    const pipeline = await toExecutable(pfm)
    expect(Object.keys(pipeline.edges)).toHaveLength(0)
    expect(Object.keys(pipeline.nodes)).toHaveLength(2)
  })

  it('rejects nodes with no action identifier', async () => {
    const pfm: PFMWorkflow = {
      nodes: [
        { section: '1', nodeName: 'Nobody', actionId: '', parameters: {}, dependencies: [] } as PFMNode,
      ],
    }
    await expect(toExecutable(pfm)).rejects.toThrow(/no action identifier/)
  })
})

describe('tryStringify — reads flat edge shape', () => {
  it('produces markdown without crashing on flat edges', async () => {
    const pfm: PFMWorkflow = {
      nodes: [
        makeUserNode('1', '1'),
        {
          section: '2',
          nodeName: 'Node 2',
          actionId: '2',
          userActionId: '019d9f37-9321-85a2-8bcc-000000000002' as UserActionId,
          parameters: {},
          dependencies: [
            { type: 'wikilink', nodeSection: '1', nodeName: 'Node 1', outputKey: 'payload' },
          ],
        },
      ],
    }
    const pipeline = await toExecutable(pfm)
    const md = tryStringify(pipeline)
    // Read-only marker header
    expect(md).toContain('# Pipeline (Read-Only)')
    // Wiki-link back-reference uses the source output key (sourceHandle under the new shape)
    expect(md).toContain('payload')
  })
})
