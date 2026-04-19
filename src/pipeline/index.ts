// Copyright (c) 2026 Wuji Labs Inc
//
// Playtiss Pipeline — a concrete data pipeline shape that satisfies the
// generic Graph primitive from @playtiss/core. Every Pipeline is a Graph,
// and any Graph consumer (proxy, third-party harness, visualizer) can
// process a Pipeline through the shared primitive.
//
// The underlying Graph / GraphNode / GraphEdge layout is defined in the
// `@playtiss/core` package. See its `graph` module for the ReactFlow
// attribution and the nullable-endpoint extension we adopt.
import type {
  AssetValue,
  Graph,
  GraphEdge,
  GraphNode,
  TraceId,
} from '@playtiss/core'

import type { UserActionId } from '../types/playtiss.js'

// Builtin actions handled by the scheduler without creating worker tasks.
// TODO: Add 'execute' builtin — takes a pipeline definition as one input and
// data as another, dynamically instantiates and runs the pipeline inline.
export type BuiltinAction = 'split' | 'merge' | 'const'

/**
 * Pipeline node — either a user-defined action (referenced by TraceId)
 * or a builtin action (split, merge, const, and future: execute).
 *
 * Narrows GraphNode from core by fixing the `action` field to playtiss's
 * concrete vocabulary: a UserActionId reference or one of the three builtins.
 */
export interface Node extends GraphNode {
  action: UserActionId | BuiltinAction
}

// Extended Node type for const nodes that include a value property
export interface ConstNode extends Node {
  action: 'const'
  value: AssetValue // The constant value to output
}

// Type guard to check if a node is a const node
export function isConstNode(node: Node): node is ConstNode {
  return node.action === 'const' && 'value' in node
}

/**
 * Pipeline edge — narrows GraphEdge from core by requiring non-null handle
 * names on both ends. The Collaboration Protocol core allows null handles
 * (meaning "default port"), but playtiss pipelines assign explicit slot
 * names (with `%`-prefixed context slots, `^`-prefixed meta slots, or plain
 * data slot names) so we fix non-null handles here.
 *
 * `source` / `target` remain `TraceId | null` — null indicates the edge is
 * wired to the pipeline's own input/output boundary instead of another node.
 */
export interface Edge extends GraphEdge {
  sourceHandle: string
  targetHandle: string
}

/** JSON Schema (Draft 2020-12 compatible subset stored as AssetValue) */
export type JsonSchema = AssetValue

/**
 * Pipeline — a concrete executable graph in the playtiss SDK.
 *
 * Pipeline satisfies the `Graph` type from @playtiss/core: every Pipeline IS
 * a Graph. Any code written against the generic Graph primitive (a third-party
 * visualizer, the proxy's SessionDAG code, a cross-substrate passport) will
 * accept a Pipeline without modification. Pipeline adds playtiss-specific
 * fields (description + I/O schemas) and narrows the node/edge types to
 * playtiss's concrete Node and Edge.
 */
export interface Pipeline extends Graph {
  description: string
  input_schema: JsonSchema
  output_schema: JsonSchema
  nodes: Record<TraceId, Node>
  edges: Record<TraceId, Edge>
}
