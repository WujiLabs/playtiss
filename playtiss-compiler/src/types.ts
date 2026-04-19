// Copyright (c) 2026 Wuji Labs Inc
import type { SystemActionId, UserActionId } from '@playtiss/core'
import type { BuiltinAction, Edge, Node, Pipeline } from 'playtiss/pipeline'

/**
 * Section number in hierarchical format
 * Examples: "1", "1.1", "1.2.3", "2.a", "2.b.1"
 * Supports mixed numeric/letter hierarchies
 */
export type SectionNumber = string

/**
 * User action ID format: "scope_id:action_name"
 * Built-in actions: "split" | "merge" | "const"
 * @deprecated Use SystemActionId, BuiltinAction, or UserActionId instead
 */
export type PFMActionId = string

/**
 * PFM (Playtiss Flavored Markdown) Node representation (Intermediate Format)
 *
 * This is the intermediate representation that preserves ALL metadata from markdown.
 * Use toExecutable() to convert to Pipeline for execution.
 */
export interface PFMNode {
  /** Section number (hierarchical, e.g., "1", "1.1", "1.2.3", "2.a") */
  section: SectionNumber
  /** Human-readable name of the node */
  name: string
  /** Action ID (e.g., "core:google_search" or "split"/"merge") - human-readable identifier */
  actionId: string

  // Pattern 2: UserActionId persistence
  // One of these will be set based on actionId:
  /** UUID for user-defined actions (persists across LLM edits) */
  userActionId?: UserActionId
  /** Resolved system action if actionId starts with "core:" */
  systemActionId?: SystemActionId
  /** Resolved builtin action if actionId is "split", "merge", or "const" */
  builtinAction?: BuiltinAction

  /** Parameters for the action */
  parameters: Record<string, PFMValue>
  /** Chain of thought comments (preserved in round-trip) */
  chainOfThought?: string
  /** Dependencies extracted from wiki-link parameters */
  dependencies: PFMWikiLink[]
}

/**
 * PFM value type - supports primitives, wiki-links, arrays, and objects
 */
export type PFMValue
  = | string
    | number
    | boolean
    | null
    | PFMWikiLink
    | PFMValue[]
    | { [key: string]: PFMValue }

/**
 * Wiki-Link reference to another node's output
 * Format: [[<Section>. <NodeName>.<OutputKey>]]
 * Example: [[1.2. Validate Email.result]]
 */
export interface PFMWikiLink {
  type: 'wikilink'
  /** Section number of the referenced node */
  nodeSection: SectionNumber
  /** Name of the referenced node (for human readability) */
  nodeName: string
  /** Output key/slot name */
  outputKey: string
}

/**
 * Workflow metadata
 */
export interface WorkflowMetadata {
  /** PFM format version */
  version?: string
  /** Creation timestamp */
  created?: number
  /** Workflow description */
  description?: string
}

/**
 * PFM Workflow - Intermediate representation (preserves ALL metadata)
 *
 * This is the editable format that:
 * - Preserves chain of thought, section numbers, node names, ordering
 * - Can be round-tripped without loss: stringify(parse(md)) === md
 * - Supports hierarchical section numbering (1.1, 1.2.3, etc.)
 * - Maintains UserActionId persistence across LLM edits
 *
 * Use toExecutable() to convert to Pipeline for execution.
 */
export interface PFMWorkflow {
  /** Ordered array of nodes (preserves markdown order) */
  nodes: PFMNode[]
  /** Optional workflow metadata */
  metadata?: WorkflowMetadata
}

/**
 * Parse section number (basic validation)
 * @param str Section number string
 * @returns Validated SectionNumber or null if invalid
 */
export function parseSectionNumber(str: string): SectionNumber | null {
  // Allow numeric sections: "1", "1.1", "1.2.3"
  // Allow letter sections: "a", "a.b", "a.b.c"
  // Allow mixed: "1.a", "2.b.1"
  const pattern = /^[0-9a-z]+(\.[0-9a-z]+)*$/i
  return pattern.test(str) ? str : null
}

/**
 * Compare two section numbers (Pattern 3)
 * @param a First section number
 * @param b Second section number
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSectionNumbers(a: SectionNumber, b: SectionNumber): number {
  // Split into parts
  const aParts = a.split('.')
  const bParts = b.split('.')

  // Compare part by part
  const maxLen = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < maxLen; i++) {
    const aPart = aParts[i] || ''
    const bPart = bParts[i] || ''

    // Try numeric comparison first
    const aNum = parseInt(aPart, 10)
    const bNum = parseInt(bPart, 10)

    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum < bNum) return -1
      if (aNum > bNum) return 1
    }
    else {
      // Lexicographic comparison for letters
      if (aPart < bPart) return -1
      if (aPart > bPart) return 1
    }
  }

  return 0
}

/**
 * Validate section number ordering (Pattern 3)
 * Checks for duplicates and strict ordering
 * Note: Missing intermediate sections are allowed (1.1 → 1.3 is OK)
 */
export function validateSectionOrder(sections: SectionNumber[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // Check for duplicates
  const seen = new Set<SectionNumber>()
  for (const section of sections) {
    if (seen.has(section)) {
      issues.push({
        type: 'duplicate_section',
        message: `Duplicate section number: ${section}`,
        section,
      })
    }
    seen.add(section)
  }

  // Check strict ordering (Pattern 3)
  for (let i = 1; i < sections.length; i++) {
    if (compareSectionNumbers(sections[i - 1], sections[i]) >= 0) {
      issues.push({
        type: 'invalid_section_order',
        message: `Section ${sections[i]} must come after ${sections[i - 1]}`,
        section: sections[i],
      })
    }
  }

  return issues
}

/**
 * Result of workflow validation
 */
export interface ValidationResult {
  /** Whether the workflow is valid */
  valid: boolean
  /** List of validation errors */
  errors: ValidationIssue[]
  /** List of validation warnings */
  warnings: ValidationIssue[]
}

/**
 * Validation issue (error or warning)
 */
export interface ValidationIssue {
  /** Type of validation issue */
  type:
    | 'cycle_detected'
    | 'undefined_reference'
    | 'invalid_action_id'
    | 'duplicate_section'
    | 'invalid_section_order'
    | 'non_topological_order'
    | 'unknown'
  /** Human-readable error message */
  message: string
  /** Section number where the issue occurred (if applicable) */
  section?: SectionNumber
  /** Index of the node where the issue occurred (if applicable) @deprecated Use section instead */
  nodeIndex?: number
  /** Action ID where the issue occurred (if applicable) */
  actionId?: string
}

/**
 * Context System (v9):
 *
 * Each workflow node can have multiple task instances when fed by a split node.
 * Each task has a different context key (edges with @ prefix).
 * Tasks can later be merged back into one.
 *
 * Current implementation: Basic support, full context handling deferred to Phase 2+
 */
export interface ContextMetadata {
  /** Context key (for split/merge operations) */
  contextKey?: string
  /** Whether this node is part of a split/merge context */
  isContextual?: boolean
}

// Re-export Pipeline types from playtiss for convenience
export type { BuiltinAction, Edge, Node, Pipeline, SystemActionId, UserActionId }
export { type ConstNode, isConstNode } from 'playtiss/pipeline'
