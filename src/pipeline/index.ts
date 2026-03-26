// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  type AssetValue,
  type DictAsset,
} from '../index.js'
import type { UserActionId } from '../types/playtiss.js'
import type { TraceId } from '../types/trace_id.js'

type PipelineInputSlot = { node: null, name: string }
type PipelineOutputSlot = { node: null, name: string }
type NodeInputSlot = { node: TraceId, name: string }
type NodeOutputSlot = { node: TraceId, name: string }

export type EdgeSourceSlot = NodeOutputSlot | PipelineInputSlot
export type EdgeTargetSlot = NodeInputSlot | PipelineOutputSlot

// Builtin actions handled by the scheduler without creating worker tasks.
// TODO: Add 'execute' builtin — takes a pipeline definition as one input and
// data as another, dynamically instantiates and runs the pipeline inline.
export type BuiltinAction = 'split' | 'merge' | 'const'

/**
 * Pipeline node — either a user-defined action (referenced by TraceId)
 * or a builtin action (split, merge, const, and future: execute).
 */
export interface Node extends DictAsset {
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

export interface Edge extends DictAsset {
  source: EdgeSourceSlot
  target: EdgeTargetSlot
}

/** JSON Schema (Draft 2020-12 compatible subset stored as AssetValue) */
export type JsonSchema = AssetValue

export interface Pipeline extends DictAsset {
  description: string
  input_schema: JsonSchema
  output_schema: JsonSchema
  nodes: Record<TraceId, Node>
  edges: Record<TraceId, Edge>
}
