// Copyright (c) 2026 Wuji Labs Inc
import { generateTraceId } from '@playtiss/core'

import { ParseError } from './errors.js'
import type {
  BuiltinAction,
  PFMNode,
  PFMValue,
  PFMWikiLink,
  PFMWorkflow,
  SectionNumber,
  SystemActionId,
  UserActionId,
} from './types.js'
import { validateSectionOrder } from './types.js'

/**
 * Parse Playtiss Flavored Markdown (PFM) into intermediate workflow representation
 *
 * @param markdown - PFM markdown string
 * @param prev - Optional previous PFMWorkflow to preserve UserActionIds across edits
 * @returns PFMWorkflow (intermediate representation with all metadata)
 * @throws ParseError if markdown is malformed or uses legacy format
 */
export async function parse(markdown: string, prev?: PFMWorkflow): Promise<PFMWorkflow> {
  // Pattern 1: Reject legacy format with ? markers
  if (markdown.includes('## ?')) {
    throw new ParseError(
      'Cannot parse legacy format (sections marked with ?). '
      + 'This markdown was generated from a Pipeline and is for reference only. '
      + 'To edit, create a new workflow from scratch.',
    )
  }

  // 1. Parse into PFM AST
  const pfmDoc = parseToPFMAst(markdown)

  // 2. Validate section numbering
  validateSections(pfmDoc.nodes)

  // 3. Resolve action types and maintain UserActionId mapping
  const nodes = resolvePFMNodes(pfmDoc.nodes, prev)

  // 4. Extract metadata
  const metadata = extractMetadata(markdown)

  return {
    nodes,
    metadata,
  }
}

/**
 * Parse markdown string into PFM AST
 */
function parseToPFMAst(markdown: string): PFMWorkflow {
  const lines = markdown.split('\n')
  const nodes: PFMNode[] = []
  let currentNode: Partial<PFMNode> | null = null
  let currentParameters: Record<string, PFMValue> = {}
  let chainOfThought: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip empty lines
    if (!trimmed) continue

    // Parse node header: ## <Section>. <Name> (<action_id>)
    // Pattern 2: Support hierarchical sections (1.1, 1.2.3, 2.a, etc.)
    const headerMatch = trimmed.match(/^##\s+([0-9a-z.]+)\.\s+(.+?)\s+\((.+?)\)\s*$/i)
    if (headerMatch) {
      // Save previous node if exists
      if (currentNode && currentNode.section !== undefined) {
        nodes.push({
          ...currentNode,
          parameters: currentParameters,
          chainOfThought: chainOfThought.length > 0 ? chainOfThought.join('\n') : undefined,
          dependencies: [], // Will be extracted later
        } as PFMNode)
      }

      // Start new node
      const [, section, name, actionId] = headerMatch
      currentNode = {
        section: section.trim(),
        name: name.trim(),
        actionId: actionId.trim(),
      }
      currentParameters = {}
      chainOfThought = []
      continue
    }

    // Parse chain of thought: > comment
    if (trimmed.startsWith('>')) {
      const comment = trimmed.slice(1).trim()
      chainOfThought.push(comment)
      continue
    }

    // Parse parameter: - key: value
    const paramMatch = trimmed.match(/^-\s+([^:]+):\s*(.*)$/)
    if (paramMatch && currentNode) {
      const [, key, valueStr] = paramMatch
      const value = parseValue(valueStr.trim(), i + 1)
      currentParameters[key.trim()] = value
      continue
    }

    // Ignore other lines (could be metadata or whitespace)
  }

  // Save last node
  if (currentNode && currentNode.section !== undefined) {
    nodes.push({
      ...currentNode,
      parameters: currentParameters,
      chainOfThought: chainOfThought.length > 0 ? chainOfThought.join('\n') : undefined,
      dependencies: [], // Will be extracted later
    } as PFMNode)
  }

  return { nodes }
}

/**
 * Parse a value from PFM parameter string
 */
function parseValue(valueStr: string, line: number): PFMValue {
  // Handle wiki-link: [[<Section>. <NodeName>.<OutputKey>]]
  // Pattern 2: Support hierarchical sections (1.1, 1.2.3, 2.a, etc.)
  const wikiLinkMatch = valueStr.match(/^\[\[([0-9a-z.]+)\.\s+(.+?)\.(.+?)\]\]$/i)
  if (wikiLinkMatch) {
    const [, section, nodeName, outputKey] = wikiLinkMatch
    return {
      type: 'wikilink',
      nodeSection: section.trim(),
      nodeName: nodeName.trim(),
      outputKey: outputKey.trim(),
    } as PFMWikiLink
  }

  // Handle array: [value1, value2, ...]
  if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
    try {
      const parsed = JSON.parse(valueStr)
      if (Array.isArray(parsed)) {
        return parsed.map(v => parseValue(JSON.stringify(v), line))
      }
    }
    catch {
      // Fall through to string
    }
  }

  // Handle object: {"key": "value", ...}
  if (valueStr.startsWith('{') && valueStr.endsWith('}')) {
    try {
      const parsed = JSON.parse(valueStr)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const result: Record<string, PFMValue> = {}
        for (const [k, v] of Object.entries(parsed)) {
          result[k] = parseValue(JSON.stringify(v), line)
        }
        return result
      }
    }
    catch {
      // Fall through to string
    }
  }

  // Handle null
  if (valueStr === 'null') return null

  // Handle boolean
  if (valueStr === 'true') return true
  if (valueStr === 'false') return false

  // Handle number
  const num = Number(valueStr)
  if (!isNaN(num) && valueStr.trim() !== '') {
    return num
  }

  // Handle quoted string
  if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
    return valueStr.slice(1, -1)
  }

  // Default to string
  return valueStr
}

/**
 * Extract all wiki-links from parameter values
 */
function extractWikiLinks(params: Record<string, PFMValue>): PFMWikiLink[] {
  const wikiLinks: PFMWikiLink[] = []

  function traverse(value: PFMValue) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return
    }

    if (typeof value === 'object' && 'type' in value && value.type === 'wikilink') {
      wikiLinks.push(value as PFMWikiLink)
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        traverse(item)
      }
      return
    }

    if (typeof value === 'object') {
      for (const v of Object.values(value)) {
        traverse(v)
      }
    }
  }

  for (const value of Object.values(params)) {
    traverse(value)
  }

  return wikiLinks
}

/**
 * Validate section numbering (Pattern 3)
 */
function validateSections(nodes: PFMNode[]): void {
  const sections = nodes.map(n => n.section)
  const issues = validateSectionOrder(sections)
  if (issues.length > 0) {
    throw new ParseError(
      `Invalid section numbering: ${issues.map(i => i.message).join(', ')}`,
    )
  }
}

/**
 * Resolve action types and maintain UserActionId mapping (Pattern 2, Pattern 4)
 */
function resolvePFMNodes(pfmNodes: PFMNode[], prev?: PFMWorkflow): PFMNode[] {
  // Build section → UserActionId mapping from prev state
  const sectionToActionId = new Map<SectionNumber, UserActionId>()

  if (prev) {
    for (const node of prev.nodes) {
      if (node.userActionId) {
        sectionToActionId.set(node.section, node.userActionId)
      }
    }
  }

  // Resolve each node's action type and extract dependencies
  return pfmNodes.map((pfmNode) => {
    const node = { ...pfmNode }

    // Pattern 4: Distinguish action types
    if (['split', 'merge', 'const'].includes(pfmNode.actionId)) {
      node.builtinAction = pfmNode.actionId as BuiltinAction
    }
    else if (pfmNode.actionId.startsWith('core:')) {
      node.systemActionId = pfmNode.actionId as SystemActionId
    }
    else {
      // User-defined action: get from prev state or generate new
      node.userActionId = sectionToActionId.get(pfmNode.section)
        || (generateTraceId() as UserActionId)
    }

    // Extract dependencies from wiki-link parameters
    node.dependencies = extractWikiLinks(pfmNode.parameters)

    return node
  })
}

/**
 * Extract metadata from markdown (e.g., title)
 */
function extractMetadata(markdown: string): { description?: string } | undefined {
  const lines = markdown.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Extract first H1 as description
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      return {
        description: trimmed.slice(2).trim(),
      }
    }
  }
  return undefined
}
