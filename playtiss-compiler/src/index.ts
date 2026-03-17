// Copyright (c) 2026 Wuji Labs Inc
/**
 * @playtiss/compiler
 *
 * Playtiss Flavored Markdown (PFM) compiler for workflow definitions.
 *
 * This package provides bidirectional conversion between:
 * - **PFM** (Playtiss Flavored Markdown) - LLM-friendly editable text format
 * - **PFMWorkflow** - Intermediate representation preserving metadata
 * - **Pipeline** - Executable DAG representation
 *
 * @example
 * ```typescript
 * import { parse, stringify, validate, toExecutable } from '@playtiss/compiler';
 *
 * // Parse PFM to intermediate representation
 * const pfm = await parse(markdown);
 *
 * // Validate workflow
 * const result = validate(pfm);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 *
 * // Convert to executable Pipeline
 * const pipeline = await toExecutable(pfm);
 *
 * // Convert back to PFM (preserves metadata)
 * const md = stringify(pfm);
 * ```
 */

// Main API
export { compile, toExecutable, tryStringify, type StoreFunction } from './executable.js'
export { parse } from './parser.js'
export { stringify } from './stringifier.js'
export { throwOnValidationError, validate } from './validator.js'

// Errors
export * from './errors.js'

// Types
export type {
  BuiltinAction,
  PFMNode,
  PFMValue,
  PFMWikiLink,
  PFMWorkflow,
  SectionNumber,
  SystemActionId,
  ValidationIssue,
  ValidationResult,
  WorkflowMetadata,
} from './types.js'

// Re-export Pipeline types from playtiss for convenience
export type { Edge, Node, Pipeline, UserActionId } from './types.js'
