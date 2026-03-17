// Copyright (c) 2026 Wuji Labs Inc
import { CompoundAssetReference, isReference, toAssetId, type AssetId, type CompoundAssetId, type DictLazyAsset, type LazyAsset } from 'playtiss'
import { store as defaultStore } from 'playtiss/asset-store'
import { isConstNode, type ConstNode, type Edge, type Node, type Pipeline } from 'playtiss/pipeline'
import { parse } from './parser.js'
import type {
  BuiltinAction,
  PFMWikiLink,
  PFMWorkflow,
  SectionNumber,
  SystemActionId,
  UserActionId,
} from './types.js'

/**
 * Store function type for asset storage
 * Accepts any asset and returns a CompoundAssetId
 */
export type StoreFunction = (asset: DictLazyAsset) => Promise<CompoundAssetId>

/**
 * Convert PFMWorkflow (intermediate) to Pipeline (executable)
 *
 * This strips metadata like chainOfThought, section numbers, and node names,
 * producing a content-addressable DAG ready for execution.
 *
 * @param pfm - PFMWorkflow (intermediate representation)
 * @param options - Optional configuration
 * @param options.store - Custom store function (defaults to playtiss/asset-store)
 * @returns Pipeline (executable representation)
 */
export async function toExecutable(
  pfm: PFMWorkflow,
  options?: { store?: StoreFunction },
): Promise<Pipeline> {
  const store = options?.store ?? defaultStore
  const nodes: Record<string, Node> = {}
  const edges: Record<string, Edge> = {}

  // Map section → CompoundAssetId
  const sectionToId = new Map<SectionNumber, CompoundAssetId>()

  // Create nodes using proper action types (Pattern 4)
  for (const pfmNode of pfm.nodes) {
    let action: UserActionId | BuiltinAction

    if (pfmNode.builtinAction) {
      action = pfmNode.builtinAction
    }
    else if (pfmNode.systemActionId) {
      // System actions need to be looked up and converted to UserActionId
      // For now, throw an error - this will be implemented when the action registry is available
      throw new Error(
        `System action ${pfmNode.systemActionId} needs to be resolved to UserActionId. `
        + 'Action registry lookup not yet implemented.',
      )
    }
    else if (pfmNode.userActionId) {
      action = pfmNode.userActionId
    }
    else {
      throw new Error(`Node ${pfmNode.section} has no action identifier`)
    }

    let node: Node

    // Handle const nodes specially - they need the value property
    if (pfmNode.builtinAction === 'const') {
      // Const nodes require a 'value' parameter
      const valueParam = pfmNode.parameters.value
      if (valueParam === undefined) {
        throw new Error(
          `Const node at section ${pfmNode.section} requires a 'value' parameter`,
        )
      }

      node = {
        asset_type: 'pipeline_node',
        action: 'const',
        use_task_creator: false,
        value: valueParam as LazyAsset,
        creator: 'compiler',
        timestamp: Date.now(),
      } satisfies ConstNode
    }
    else {
      node = {
        asset_type: 'pipeline_node',
        action,
        use_task_creator: !pfmNode.builtinAction,
        creator: 'compiler',
        timestamp: Date.now(),
      }
    }

    const nodeId = await store(node) // Returns CompoundAssetId (@hash)
    sectionToId.set(pfmNode.section, nodeId)
    // Pipeline.nodes uses AssetId (hash without @) as key
    nodes[toAssetId(nodeId)] = node
  }

  // Create edges from dependencies
  for (const pfmNode of pfm.nodes) {
    const targetId = sectionToId.get(pfmNode.section)
    if (!targetId) {
      throw new Error(`Missing node ID for section ${pfmNode.section}`)
    }

    for (const dep of pfmNode.dependencies) {
      const sourceId = sectionToId.get(dep.nodeSection)
      if (!sourceId) {
        throw new Error(
          `Undefined reference: Section ${dep.nodeSection} (referenced by ${pfmNode.section})`,
        )
      }

      const edge: Edge = {
        asset_type: 'pipeline_edge',
        source: {
          node: new CompoundAssetReference(toAssetId(sourceId), null),
          name: dep.outputKey,
        },
        target: {
          node: new CompoundAssetReference(toAssetId(targetId), null),
          name: dep.outputKey, // Use outputKey as parameter name
        },
        creator: 'compiler',
        timestamp: Date.now(),
      }

      const edgeId = await store(edge) // Returns CompoundAssetId (@hash)
      // Pipeline.edges uses AssetId (hash without @) as key
      edges[toAssetId(edgeId)] = edge
    }
  }

  // Return complete Pipeline with all required Action fields
  const pipeline: Pipeline = {
    // Pipeline-specific fields
    nodes,
    edges,

    // Action fields (Pipeline extends Action)
    asset_type: 'action',
    description: pfm.metadata?.description || 'Compiled Workflow',
    input_shape: {}, // TODO: Infer from workflow inputs
    output_shape: {}, // TODO: Infer from workflow outputs

    // NodeBase fields (Action extends NodeBase)
    creator: 'compiler',
    timestamp: Date.now(),
  }

  return pipeline
}

/**
 * Convert Pipeline (executable) to read-only markdown (Pattern 5)
 *
 * This produces a markdown representation for LLM understanding of legacy workflows.
 * Uses ? markers in section numbers to prevent recompilation.
 *
 * **NOT RECOMPILABLE**: The parser will reject this format.
 *
 * @param pipeline - Pipeline (executable representation)
 * @returns Read-only PFM markdown with ? markers
 */
export function tryStringify(pipeline: Pipeline): string {
  const lines: string[] = []

  // Build node list (keys are AssetId - hash without @ prefix)
  // Object.keys returns string[], but we know they're AssetId (SHA256)
  const nodeIds = Object.keys(pipeline.nodes) as AssetId[]
  const nodeToSection = new Map<string, string>()

  // Assign section numbers (simple sequential numbering with ? markers)
  for (let i = 0; i < nodeIds.length; i++) {
    nodeToSection.set(nodeIds[i], `?${i + 1}`)
  }

  // Warning header
  lines.push('# Pipeline (Read-Only)')
  lines.push('')
  lines.push('**NOTE:** This is a read-only representation of a Pipeline.')
  lines.push(
    'Section numbers are marked with `?` and this format cannot be recompiled.',
  )
  lines.push(
    'To create an editable workflow, start from scratch using the rich PFM format.',
  )
  lines.push('')

  // Convert nodes
  for (const nodeId of nodeIds) {
    const node = pipeline.nodes[nodeId]
    if (!node) continue

    const section = nodeToSection.get(nodeId) || '?'

    // Find dependencies
    const dependencies: PFMWikiLink[] = []
    const edges = Object.values(pipeline.edges) as Edge[]
    for (const edge of edges) {
      const targetNodeId = edge.target.node?.ref
      // Edge refs are CompoundAssetId (@hash), convert to AssetId for comparison
      if (targetNodeId && toAssetId(targetNodeId) === nodeId) {
        const sourceNodeId = edge.source.node?.ref
        if (sourceNodeId) {
          const sourceAssetId = toAssetId(sourceNodeId)
          const sourceSection = nodeToSection.get(sourceAssetId) || '?'
          const sourceNode = pipeline.nodes[sourceAssetId]
          if (sourceNode) {
            dependencies.push({
              type: 'wikilink',
              nodeSection: sourceSection,
              nodeName: formatActionName(sourceNode.action),
              outputKey: edge.source.name,
            })
          }
        }
      }
    }

    // Node header with ? marker
    const actionName = formatActionName(node.action)
    lines.push(`## ${section}. ${actionName} (${node.action})`)
    lines.push('')

    // For const nodes, show the value
    if (isConstNode(node)) {
      lines.push(`- value: ${formatConstValue(node.value)}`)
    }

    // Dependencies as wiki-links
    for (const dep of dependencies) {
      lines.push(
        `- ${dep.outputKey}: `
        + `[[${dep.nodeSection}. ${dep.nodeName}.${dep.outputKey}]]`,
      )
    }

    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Convenience function: parse PFM → Pipeline in one step
 *
 * Equivalent to: `toExecutable(await parse(markdown, prev))`
 *
 * @param markdown - PFM markdown string
 * @param prev - Optional previous workflow state (for UserActionId persistence)
 * @param options - Optional configuration
 * @param options.store - Custom store function (defaults to playtiss/asset-store)
 * @returns Pipeline (executable representation)
 */
export async function compile(
  markdown: string,
  prev?: PFMWorkflow,
  options?: { store?: StoreFunction },
): Promise<Pipeline> {
  const pfm = await parse(markdown, prev)
  return toExecutable(pfm, options)
}

/**
 * Format action name for display
 */
function formatActionName(action: UserActionId | SystemActionId | BuiltinAction): string {
  if (typeof action === 'string') {
    // Remove core: prefix and replace underscores with spaces
    return action.replace('core:', '').replace(/_/g, ' ')
  }
  return 'Unknown Action'
}

/**
 * Format const node value for display
 * Handles references (CompoundAssetReference, BinaryAssetReference) and binary buffers
 */
function formatConstValue(value: LazyAsset): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'

  // Handle asset references - display the ref string (@hash or #hash)
  if (isReference(value)) {
    return value.ref
  }

  // Handle Uint8Array (binary buffer)
  if (value instanceof Uint8Array) {
    return `[Binary: ${value.length} bytes]`
  }

  // For other values, use JSON.stringify
  try {
    return JSON.stringify(value)
  }
  catch {
    return '[Complex Value]'
  }
}
