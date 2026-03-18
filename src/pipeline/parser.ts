// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import { load } from '../asset-store/index.js'
import { type AssetId } from '../index.js'
import { isTraceId } from '../types/trace_id.js'
import { type Edge, type Node, type Pipeline } from './index.js'

export interface NodeSlotInfo {
  node: AssetId | null // null indicates pipeline output
  tag_edges: Edge[] // target is tag slot
  slot_edges: Edge[] // target is regular slot
}

type NodeType = 'regular' | 'merge' | 'task_split' | 'task_merge' | 'const'

export interface PipelineInfo {
  nodes: Record<AssetId, Node>
  input_next: NodeSlotInfo[]
  node_nexts: Record<AssetId, NodeSlotInfo[]>
  node_slots: Record<AssetId, string[]>
  node_types: Record<AssetId, NodeType>
  output_type: NodeType
  output_slots: string[]
}

function mergeSlots(all_slots: NodeSlotInfo[]): NodeSlotInfo[] {
  const slotDict: Record<string, NodeSlotInfo> = {}
  all_slots.map((slots) => {
    const node_id = slots.node || 'null'
    if (node_id in slotDict) {
      const { tag_edges, slot_edges } = slots
      slotDict[node_id].tag_edges.push(...tag_edges)
      slotDict[node_id].slot_edges.push(...slot_edges)
    }
    else {
      slotDict[node_id] = slots
    }
  })
  return Object.values(slotDict)
}

const pipelineInfoCache = new Map<AssetId, PipelineInfo>()

export async function parsePipeline(
  pipelineId: AssetId,
): Promise<PipelineInfo> {
  if (pipelineInfoCache.has(pipelineId)) {
    return pipelineInfoCache.get(pipelineId)!
  }
  const pipeline = await load(pipelineId) as unknown as Pipeline
  const info: PipelineInfo = {
    nodes: pipeline.nodes,
    input_next: [],
    node_nexts: {},
    node_types: {},
    node_slots: {},
    output_type: 'regular',
    output_slots: [],
  }
  const slots_set: Record<AssetId | 'output', Set<string>> = {
    output: new Set<string>(),
  }
  // record the source of each target, or 'multiple' if there are more than 1
  // if there are more than 1 source, the node is a merge node
  // otherwise it is a regular node
  // TODO: handle dynamic merge and dynamic action
  const node_input_id: Record<string, AssetId | null | 'multiple'> = {}

  // Pre-initialize const node types (they are source nodes with no incoming edges)
  for (const [nodeId, node] of Object.entries(pipeline.nodes)) {
    if (node.action === 'const') {
      info.node_types[nodeId as AssetId] = 'const'
    }
  }
  Object.values(pipeline.edges).map((edge) => {
    const { source, target } = edge
    const source_node_id = source.node || null
    const target_node_id = target.node || null
    // check if there are multiple sources connecting to target
    if (target_node_id === null) {
      // collect output slots
      if (!target.name.startsWith('%')) {
        slots_set['output'].add(target.name)
      }
      if ('output' in node_input_id) {
        // multiple nodes connecting to output
        if (node_input_id['output'] !== source_node_id) {
          node_input_id['output'] = 'multiple'
          info.output_type = 'merge'
        }
      }
      else {
        node_input_id['output'] = source_node_id
      }
    }
    else {
      // collect node slots
      if (!target.name.startsWith('%')) {
        if (!(target_node_id in slots_set)) {
          slots_set[target_node_id] = new Set<string>()
        }
        slots_set[target_node_id].add(target.name)
      }
      // detect node type
      if (!(target_node_id in info.node_types)) {
        info.node_types[target_node_id] = 'regular'
        // set dynamic_split / dynamic_merge
        const action = pipeline.nodes[target_node_id].action
        if (!isTraceId(action)) {
          if (action === 'merge') {
            info.node_types[target_node_id] = 'task_merge'
          }
          else if (action === 'split') {
            info.node_types[target_node_id] = 'task_split'
          }
          else if (action === 'const') {
            info.node_types[target_node_id] = 'const'
          }
          else {
            throw new Error(`built in action ${action} not implemented`)
          }
        }
      }
      if (target_node_id in node_input_id) {
        // multiple nodes connecting to target_node_id
        if (node_input_id[target_node_id] !== source_node_id) {
          node_input_id[target_node_id] = 'multiple'
          if (
            info.node_types[target_node_id] !== 'regular'
            && info.node_types[target_node_id] !== 'merge'
          ) {
            throw new Error('built in action only accepts one node as input')
          }
          info.node_types[target_node_id] = 'merge'
        }
      }
      else {
        node_input_id[target_node_id] = source_node_id
      }
    }
    // separate tag slots and regular slots
    if (source.node === null) {
      if (target.name.startsWith('%')) {
        info.input_next.push({
          node: target_node_id,
          tag_edges: [edge],
          slot_edges: [],
        })
      }
      else {
        info.input_next.push({
          node: target_node_id,
          tag_edges: [],
          slot_edges: [edge],
        })
      }
    }
    else {
      if (source.node in info.node_nexts) {
        if (target.name.startsWith('%')) {
          info.node_nexts[source.node].push({
            node: target_node_id,
            tag_edges: [edge],
            slot_edges: [],
          })
        }
        else {
          info.node_nexts[source.node].push({
            node: target_node_id,
            tag_edges: [],
            slot_edges: [edge],
          })
        }
      }
      else {
        if (target.name.startsWith('%')) {
          info.node_nexts[source.node] = [
            { node: target_node_id, tag_edges: [edge], slot_edges: [] },
          ]
        }
        else {
          info.node_nexts[source.node] = [
            { node: target_node_id, tag_edges: [], slot_edges: [edge] },
          ]
        }
      }
    }
  })

  // add slots from slot_set
  for (const node_id in slots_set) {
    if (node_id === 'output') {
      info.output_slots = Array.from(slots_set[node_id].keys())
    }
    else {
      info.node_slots[node_id as AssetId] = Array.from(
        slots_set[node_id as AssetId].keys(),
      )
    }
  }

  // merge slots of same target
  info.input_next = mergeSlots(info.input_next)
  for (const node_id in info.node_nexts) {
    info.node_nexts[node_id as AssetId] = mergeSlots(
      info.node_nexts[node_id as AssetId],
    )
  }

  // save to cache and return
  pipelineInfoCache.set(pipelineId, info)
  return info
}
