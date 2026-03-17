// Copyright (c) 2026 Wuji Labs Inc
import {
  CycleDetectedError,
  InvalidActionIdError,
  UndefinedReferenceError,
} from './errors.js'
import type {
  PFMWorkflow,
  ValidationIssue,
  ValidationResult,
} from './types.js'
import { validateSectionOrder } from './types.js'

/**
 * Validate a PFM workflow
 *
 * Checks for:
 * - Valid section numbering (no duplicates, strict ordering)
 * - Cycles in the workflow graph
 * - Undefined node references
 * - Invalid action IDs
 *
 * @param pfm - PFMWorkflow to validate
 * @returns ValidationResult with errors and warnings
 */
export function validate(pfm: PFMWorkflow): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  // Section number validation (Pattern 3)
  const sections = pfm.nodes.map(n => n.section)
  errors.push(...validateSectionOrder(sections))

  // Build dependency graph
  const graph = buildDependencyGraph(pfm)

  // Check for cycles
  const cycleError = detectCycles(graph, sections)
  if (cycleError) {
    errors.push(cycleError)
  }

  // Validate references
  const refErrors = validateReferences(pfm)
  errors.push(...refErrors)

  // Validate action IDs
  const actionErrors = validateActionIds(pfm)
  errors.push(...actionErrors)

  // Optional: warn if order is not topologically valid
  if (!isTopologicalOrder(pfm)) {
    warnings.push({
      type: 'non_topological_order',
      message: 'Node order is not topologically sorted (may be intentional)',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Build dependency graph from PFMWorkflow
 * Returns adjacency list: section → [dependent sections]
 */
function buildDependencyGraph(pfm: PFMWorkflow): Map<string, string[]> {
  const graph = new Map<string, string[]>()

  // Initialize all sections
  for (const node of pfm.nodes) {
    graph.set(node.section, [])
  }

  // Build adjacency list from dependencies
  for (const node of pfm.nodes) {
    for (const dep of node.dependencies) {
      // dep.nodeSection → node.section (dependency points to dependent)
      const deps = graph.get(dep.nodeSection) || []
      deps.push(node.section)
      graph.set(dep.nodeSection, deps)
    }
  }

  return graph
}

/**
 * Detect cycles in the workflow graph using DFS
 */
function detectCycles(
  graph: Map<string, string[]>,
  sections: string[],
): ValidationIssue | null {
  const visited = new Set<string>()
  const recStack = new Set<string>()

  // DFS to detect cycles
  function dfs(section: string): boolean {
    visited.add(section)
    recStack.add(section)

    for (const neighbor of graph.get(section) || []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true
        }
      }
      else if (recStack.has(neighbor)) {
        // Cycle detected
        return true
      }
    }

    recStack.delete(section)
    return false
  }

  // Check all sections
  for (const section of sections) {
    if (!visited.has(section)) {
      if (dfs(section)) {
        return {
          type: 'cycle_detected',
          message: 'Workflow contains a cycle',
          section,
        }
      }
    }
  }

  return null
}

/**
 * Validate all dependency references point to existing sections
 */
function validateReferences(pfm: PFMWorkflow): ValidationIssue[] {
  const errors: ValidationIssue[] = []
  const sections = new Set(pfm.nodes.map(n => n.section))

  for (const node of pfm.nodes) {
    for (const dep of node.dependencies) {
      if (!sections.has(dep.nodeSection)) {
        errors.push({
          type: 'undefined_reference',
          message: `Section ${node.section} references undefined section ${dep.nodeSection}`,
          section: node.section,
        })
      }
    }
  }

  return errors
}

/**
 * Validate action IDs have correct format
 *
 * Valid formats:
 * - "core:action_name" (system actions)
 * - "scope:action_name" (user actions)
 * - "split" | "merge" (built-in actions)
 */
function validateActionIds(pfm: PFMWorkflow): ValidationIssue[] {
  const errors: ValidationIssue[] = []

  // Action ID patterns
  const systemActionPattern = /^core:[a-zA-Z0-9_-]+$/
  const userActionPattern = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/
  const builtinActions = ['split', 'merge']

  for (const node of pfm.nodes) {
    const actionId = node.actionId

    // Check if it's a built-in action
    if (builtinActions.includes(actionId)) {
      continue
    }

    // Check if it matches system action pattern
    if (systemActionPattern.test(actionId)) {
      continue
    }

    // Check if it matches user action pattern
    if (!userActionPattern.test(actionId)) {
      errors.push({
        type: 'invalid_action_id',
        message: `Invalid action ID format: "${actionId}". Expected "core:action", "scope:action", or built-in action.`,
        section: node.section,
        actionId,
      })
    }
  }

  return errors
}

/**
 * Check if node ordering is topologically valid
 * Returns true if all dependencies come before their dependents
 */
function isTopologicalOrder(pfm: PFMWorkflow): boolean {
  const sectionToIndex = new Map<string, number>()

  // Build section → index mapping
  for (let i = 0; i < pfm.nodes.length; i++) {
    sectionToIndex.set(pfm.nodes[i].section, i)
  }

  // Check that all dependencies come before their dependents
  for (const node of pfm.nodes) {
    const nodeIndex = sectionToIndex.get(node.section)!

    for (const dep of node.dependencies) {
      const depIndex = sectionToIndex.get(dep.nodeSection)
      if (depIndex !== undefined && depIndex >= nodeIndex) {
        // Dependency comes after dependent - not topological
        return false
      }
    }
  }

  return true
}

/**
 * Helper function to throw validation errors
 * @internal
 */
export function throwOnValidationError(result: ValidationResult): void {
  if (!result.valid) {
    for (const error of result.errors) {
      switch (error.type) {
        case 'cycle_detected':
          throw new CycleDetectedError(error.message)
        case 'undefined_reference':
          throw new UndefinedReferenceError(error.message)
        case 'invalid_action_id':
          throw new InvalidActionIdError(error.message)
        case 'duplicate_section':
        case 'invalid_section_order':
          throw new Error(error.message)
        default:
          throw new Error(error.message)
      }
    }
  }
}
