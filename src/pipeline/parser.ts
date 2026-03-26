// Copyright (c) 2026 Wuji Labs Inc
import { load } from '../asset-store/index.js'
import { type AssetId } from '../index.js'
import { isTraceId, type TraceId } from '../types/trace_id.js'
import { type Edge, type Node, type Pipeline } from './index.js'

export interface NodeSlotInfo {
  node: TraceId | null // null indicates pipeline output
  context_edges: Edge[] // target is context slot (% prefix)
  data_edges: Edge[] // target is data slot (no prefix)
  meta_edges: Edge[] // target is meta slot (^ prefix)
}

type NodeType = 'regular' | 'merge' | 'task_split' | 'task_merge' | 'const'

export interface PipelineInfo {
  nodes: Record<TraceId, Node>
  input_next: NodeSlotInfo[]
  node_nexts: Record<TraceId, NodeSlotInfo[]>
  node_slots: Record<TraceId, string[]>
  node_meta_slots: Record<TraceId, string[]>
  node_types: Record<TraceId, NodeType>
  output_type: NodeType
  output_slots: string[]
}

// ================================================================
// Step 1: Build adjacency from edges
// ================================================================

type TargetKey = TraceId | 'output'

interface Adjacency {
  /** For each target (node or 'output'), the distinct source node IDs feeding into it */
  incomingSources: Map<TargetKey, Set<TraceId | null>>
  /** For each target (node or 'output'), the set of data slot names (no prefix) */
  targetSlotNames: Map<TargetKey, Set<string>>
  /** For each target (node or 'output'), the set of meta slot names (^ prefix) */
  targetMetaSlotNames: Map<TargetKey, Set<string>>
}

function buildAdjacency(edges: Record<TraceId, Edge>): Adjacency {
  const incomingSources = new Map<TargetKey, Set<TraceId | null>>()
  const targetSlotNames = new Map<TargetKey, Set<string>>()
  const targetMetaSlotNames = new Map<TargetKey, Set<string>>()

  for (const edge of Object.values(edges)) {
    const targetKey: TargetKey = edge.target.node === null ? 'output' : edge.target.node
    const sourceId = edge.source.node

    // Track distinct sources per target
    if (!incomingSources.has(targetKey)) {
      incomingSources.set(targetKey, new Set())
    }
    incomingSources.get(targetKey)!.add(sourceId)

    // Classify slot names by prefix
    const name = edge.target.name
    if (name.startsWith('%')) {
      // Context slot — not tracked for merge readiness
    }
    else if (name.startsWith('^')) {
      // Meta slot — tracked separately for merge readiness
      if (!targetMetaSlotNames.has(targetKey)) {
        targetMetaSlotNames.set(targetKey, new Set())
      }
      targetMetaSlotNames.get(targetKey)!.add(name)
    }
    else {
      // Data slot — tracked for merge readiness
      if (!targetSlotNames.has(targetKey)) {
        targetSlotNames.set(targetKey, new Set())
      }
      targetSlotNames.get(targetKey)!.add(name)
    }
  }

  return { incomingSources, targetSlotNames, targetMetaSlotNames }
}

// ================================================================
// Step 2: Classify node types from adjacency + node definitions
// ================================================================

function classifyNodeTypes(
  nodes: Record<TraceId, Node>,
  adjacency: Adjacency,
): { nodeTypes: Record<TraceId, NodeType>, outputType: NodeType } {
  const nodeTypes: Record<TraceId, NodeType> = {}

  // First pass: assign base type from action field
  for (const [nodeId, node] of Object.entries(nodes)) {
    const id = nodeId as TraceId
    if (!isTraceId(node.action)) {
      // Builtin action
      switch (node.action) {
        case 'split': {
          nodeTypes[id] = 'task_split'
          break
        }
        case 'merge': {
          nodeTypes[id] = 'task_merge'
          break
        }
        case 'const': {
          nodeTypes[id] = 'const'
          break
        }
        default: throw new Error(`built in action ${node.action} not implemented`)
      }
    }
    else {
      nodeTypes[id] = 'regular'
    }
  }

  // Second pass: promote regular nodes with multiple distinct sources to 'merge'
  for (const [targetKey, sources] of adjacency.incomingSources) {
    if (targetKey === 'output') continue
    const nodeId = targetKey as TraceId
    if (sources.size > 1 && nodeTypes[nodeId] !== undefined) {
      if (nodeTypes[nodeId] === 'regular' || nodeTypes[nodeId] === 'merge') {
        nodeTypes[nodeId] = 'merge'
      }
      else {
        throw new Error('built in action only accepts one node as input')
      }
    }
  }

  // Determine output type
  const outputSources = adjacency.incomingSources.get('output')
  const outputType: NodeType = (outputSources && outputSources.size > 1) ? 'merge' : 'regular'

  return { nodeTypes, outputType }
}

// ================================================================
// Step 3: Build downstream connection map grouped by source
// ================================================================

function buildDownstreamMap(
  edges: Record<TraceId, Edge>,
): {
  inputConnections: NodeSlotInfo[]
  downstreamMap: Record<TraceId, NodeSlotInfo[]>
} {
  // Group edges by (sourceNodeId, targetNodeId) pair, consolidating tag/slot/meta edges
  const grouped = new Map<string, NodeSlotInfo>()

  function getGroupKey(sourceNode: TraceId | null, targetNode: TraceId | null): string {
    return `${sourceNode ?? 'null'}|${targetNode ?? 'null'}`
  }

  function getOrCreateSlotInfo(key: string, targetNode: TraceId | null): NodeSlotInfo {
    let existing = grouped.get(key)
    if (!existing) {
      existing = { node: targetNode, context_edges: [], data_edges: [], meta_edges: [] }
      grouped.set(key, existing)
    }
    return existing
  }

  for (const edge of Object.values(edges)) {
    const sourceNode = edge.source.node
    const targetNode = edge.target.node
    const key = getGroupKey(sourceNode, targetNode)
    const slotInfo = getOrCreateSlotInfo(key, targetNode)

    const name = edge.target.name
    if (name.startsWith('%')) {
      slotInfo.context_edges.push(edge)
    }
    else if (name.startsWith('^')) {
      slotInfo.meta_edges.push(edge)
    }
    else {
      slotInfo.data_edges.push(edge)
    }
  }

  // Partition into pipeline-input connections vs node-to-node connections
  const inputConnections: NodeSlotInfo[] = []
  const downstreamMap: Record<TraceId, NodeSlotInfo[]> = {}

  for (const [key, slotInfo] of grouped) {
    const [sourceStr] = key.split('|')
    if (sourceStr === 'null') {
      inputConnections.push(slotInfo)
    }
    else {
      const sourceId = sourceStr as TraceId
      if (!(sourceId in downstreamMap)) {
        downstreamMap[sourceId] = []
      }
      downstreamMap[sourceId].push(slotInfo)
    }
  }

  return { inputConnections, downstreamMap }
}

// ================================================================
// Step 4: Extract slot name sets per target node
// ================================================================

function extractSlotNames(
  adjacency: Adjacency,
): {
  nodeSlots: Record<TraceId, string[]>
  nodeMetaSlots: Record<TraceId, string[]>
  outputSlots: string[]
} {
  const nodeSlots: Record<TraceId, string[]> = {}
  const nodeMetaSlots: Record<TraceId, string[]> = {}
  let outputSlots: string[] = []

  for (const [targetKey, names] of adjacency.targetSlotNames) {
    if (targetKey === 'output') {
      outputSlots = Array.from(names)
    }
    else {
      nodeSlots[targetKey as TraceId] = Array.from(names)
    }
  }

  for (const [targetKey, names] of adjacency.targetMetaSlotNames) {
    if (targetKey !== 'output') {
      nodeMetaSlots[targetKey as TraceId] = Array.from(names)
    }
  }

  return { nodeSlots, nodeMetaSlots, outputSlots }
}

// ================================================================
// Public API (cached)
// ================================================================

const pipelineInfoCache = new Map<AssetId, PipelineInfo>()

export async function parsePipeline(
  pipelineId: AssetId,
): Promise<PipelineInfo> {
  if (pipelineInfoCache.has(pipelineId)) {
    return pipelineInfoCache.get(pipelineId)!
  }

  const pipeline = await load(pipelineId) as unknown as Pipeline
  const adjacency = buildAdjacency(pipeline.edges)
  const { nodeTypes, outputType } = classifyNodeTypes(pipeline.nodes, adjacency)
  const { inputConnections, downstreamMap } = buildDownstreamMap(pipeline.edges)
  const { nodeSlots, nodeMetaSlots, outputSlots } = extractSlotNames(adjacency)

  const info: PipelineInfo = {
    nodes: pipeline.nodes,
    input_next: inputConnections,
    node_nexts: downstreamMap,
    node_slots: nodeSlots,
    node_meta_slots: nodeMetaSlots,
    node_types: nodeTypes,
    output_type: outputType,
    output_slots: outputSlots,
  }

  pipelineInfoCache.set(pipelineId, info)
  return info
}
