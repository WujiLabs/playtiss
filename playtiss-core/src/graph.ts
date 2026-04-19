// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// ============================================================================
// Graph primitives for the Collaboration Protocol.
// ============================================================================
//
// Attribution — Graph/GraphNode/GraphEdge layout is adapted from ReactFlow
// (@xyflow/react, MIT). ReactFlow's flat edge shape
// `{ source, target, sourceHandle, targetHandle }` is the industry-standard
// pattern for node-graph edge representation and we reuse it here so that any
// visualizer, editor, or harness already written against ReactFlow-style
// edges can consume a @playtiss/core Graph with zero translation.
//
// We extend ReactFlow's convention with ONE addition: nullable `source` /
// `target` on GraphEdge. Null expresses the graph-level input / output
// boundary as an edge endpoint (an edge whose source is null is wired to
// the enclosing graph's input slot; an edge whose target is null is wired
// to the enclosing graph's output slot). ReactFlow has no separate
// "graph input" node type and therefore does not model this case.
//
// References:
//   - ReactFlow Edge API ........... https://reactflow.dev/api-reference/types/edge
//     (MIT, @xyflow/react)
//   - Rete.js Connection API ....... https://retejs.org/docs/concepts/editor/
//     (MIT, comparable flat-edge pattern)
//
// Content addressing — A Graph is a DictAsset, so computeHash(graph) yields
// a stable CID. The dag-json codec canonicalizes encoding by sorting object
// keys in UTF-8 byte order, so two producers that insert nodes/edges in
// different orders still produce identical CIDs for identical graphs.
// ============================================================================

import type { DictAsset } from './asset-value.js'
import type { TraceId } from './trace-id.js'

/**
 * A node in a content-addressed DAG.
 *
 * `action` is a plain string so core imposes no registry of node types.
 * Consumers that want a typed action vocabulary can narrow GraphNode:
 *
 *   interface Step extends GraphNode {
 *     action: 'llm_call' | 'tool_call' | 'fork_point'
 *   }
 *
 * or use @playtiss/core/task's NamespacedActionId<Prefix> for third-party
 * namespacing (e.g., 'proxy:llm_call', 'cursor:edit').
 */
export interface GraphNode extends DictAsset {
  action: string
}

/**
 * An edge in a content-addressed DAG.
 *
 * `source` / `target`:
 *   TraceId → connects to the node with that id
 *   null    → connects to the graph's input (for `source`) or output (for
 *             `target`) boundary. This is how a graph's exposed inputs and
 *             outputs are wired to internal nodes.
 *
 * `sourceHandle` / `targetHandle`:
 *   string  → named port on the node (or named input/output slot of the
 *             enclosing graph, when the corresponding end is null)
 *   null    → the node's/graph's default (unnamed) port
 *
 * Edges with BOTH source and target null represent a pass-through wire from
 * a graph input directly to a graph output. Rare but valid — downstream
 * consumers (like `pipeline/index.ts` in the playtiss SDK) may narrow the
 * edge type to disallow this if their domain requires it.
 */
export interface GraphEdge extends DictAsset {
  source: TraceId | null
  target: TraceId | null
  sourceHandle: string | null
  targetHandle: string | null
}

/**
 * A content-addressable graph. Nodes and edges are keyed by TraceId for
 * O(1) lookup; ordering is immaterial to the resulting CID because the
 * dag-json codec sorts object keys during encoding.
 */
export interface Graph extends DictAsset {
  nodes: Record<TraceId, GraphNode>
  edges: Record<TraceId, GraphEdge>
}
