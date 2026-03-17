// Copyright (c) 2026 Wuji Labs Inc
import type {
  PFMValue,
  PFMWikiLink,
  PFMWorkflow,
} from './types.js'

/**
 * Convert PFMWorkflow (intermediate) to Playtiss Flavored Markdown (PFM)
 *
 * This produces recompilable editable format that preserves:
 * - Chain of thought comments
 * - Original node ordering (NO topological sort)
 * - Hierarchical section numbers
 * - Node names
 *
 * @param pfm - PFMWorkflow (intermediate representation)
 * @returns PFM markdown string
 */
export function stringify(pfm: PFMWorkflow): string {
  const lines: string[] = []

  // Metadata header (optional)
  if (pfm.metadata?.description) {
    lines.push(`# ${pfm.metadata.description}`)
    lines.push('')
  }

  // Nodes in array order (NO topological sort - Pattern 3)
  for (const node of pfm.nodes) {
    // Node header
    lines.push(`## ${node.section}. ${node.name} (${node.actionId})`)
    lines.push('')

    // Chain of thought (preserved!)
    if (node.chainOfThought) {
      for (const line of node.chainOfThought.split('\n')) {
        lines.push(`> ${line}`)
      }
      lines.push('')
    }

    // Parameters (excluding wiki-links which are in dependencies)
    for (const [key, value] of Object.entries(node.parameters)) {
      // Skip wiki-link values (they're in dependencies)
      if (isWikiLink(value)) continue

      lines.push(`- ${key}: ${formatValue(value)}`)
    }

    // Dependencies as wiki-links
    for (const dep of node.dependencies) {
      // Infer parameter key from dependency (use outputKey as default)
      const paramKey = dep.outputKey
      lines.push(`- ${paramKey}: [[${dep.nodeSection}. ${dep.nodeName}.${dep.outputKey}]]`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Check if a value is a wiki-link
 */
function isWikiLink(value: PFMValue): value is PFMWikiLink {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'type' in value
    && value.type === 'wikilink'
}

/**
 * Format a PFM value for markdown output
 */
function formatValue(value: PFMValue): string {
  // Handle null
  if (value === null) {
    return 'null'
  }

  // Handle boolean
  if (typeof value === 'boolean') {
    return value.toString()
  }

  // Handle number
  if (typeof value === 'number') {
    return value.toString()
  }

  // Handle string
  if (typeof value === 'string') {
    // Quote strings that contain special characters
    if (value.includes(':') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '\\"')}"`
    }
    return `"${value}"`
  }

  // Handle array
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(v => formatValue(v)))
  }

  // Handle wiki-link
  if (isWikiLink(value)) {
    return `[[${value.nodeSection}. ${value.nodeName}.${value.outputKey}]]`
  }

  // Handle object
  if (typeof value === 'object') {
    const formatted: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) {
      formatted[k] = formatValue(v)
    }
    return JSON.stringify(formatted)
  }

  return String(value)
}
