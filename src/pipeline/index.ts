// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  type AssetId,
  type AssetValue,
  type DictAsset,
} from '../index.js'
import type { UserActionId } from '../types/playtiss.js'

// keep format consistent to NodeOutputRef
type PipelineInputSlot = {
  node: null
  name: string
}

// keep format consistent to NodeInputRef
type PipelineOutputSlot = {
  node: null
  name: string
}

type NodeInputSlot = {
  node: AssetId
  name: string
}
type NodeOutputSlot = {
  node: AssetId
  name: string
}

export type EdgeSourceSlot = NodeOutputSlot | PipelineInputSlot
export type EdgeTargetSlot = NodeInputSlot | PipelineOutputSlot

export type BuiltinAction = 'split' | 'merge' | 'const'

// Base Node interface - used for regular action and builtin split/merge nodes
export interface Node extends DictAsset {
  asset_type: 'pipeline_node'
  action: UserActionId | BuiltinAction // | EdgeSourceSlot; // output of an action as a dynamic action
  use_task_creator: boolean // false: use pipeline worker as creator; true: use task creator
  timestamp: number // Required to differentiate nodes with the same action (content-addressable uniqueness)
}

// Extended Node type for const nodes that include a value property
export interface ConstNode extends Node {
  action: 'const'
  use_task_creator: false
  value: AssetValue // The constant value to output
}

// Type guard to check if a node is a const node
export function isConstNode(node: Node): node is ConstNode {
  return node.action === 'const' && 'value' in node
}

export interface Edge extends DictAsset {
  asset_type: 'pipeline_edge'
  source: EdgeSourceSlot
  target: EdgeTargetSlot
}

export interface Pipeline extends DictAsset {
  asset_type: 'action'
  timestamp: number
  description: string
  input_shape: AssetValue
  output_shape: AssetValue
  nodes: Record<AssetId, Node>
  edges: Record<AssetId, Edge>
}
