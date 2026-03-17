// Copyright (c) 2026 Wuji Labs Inc
/**
 * Base error class for compiler errors
 */
export class CompilerError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(message)
    this.name = 'CompilerError'
  }
}

/**
 * Error thrown when parsing fails
 */
export class ParseError extends CompilerError {
  constructor(message: string, line?: number, column?: number) {
    super(message, line, column)
    this.name = 'ParseError'
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends CompilerError {
  constructor(message: string, public readonly nodeIndex?: number) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * Error thrown when a cycle is detected in the workflow graph
 */
export class CycleDetectedError extends ValidationError {
  constructor(message: string, nodeIndex?: number) {
    super(message, nodeIndex)
    this.name = 'CycleDetectedError'
  }
}

/**
 * Error thrown when a reference to an undefined node is found
 */
export class UndefinedReferenceError extends ValidationError {
  constructor(message: string, nodeIndex?: number) {
    super(message, nodeIndex)
    this.name = 'UndefinedReferenceError'
  }
}

/**
 * Error thrown when an invalid action ID is encountered
 */
export class InvalidActionIdError extends ValidationError {
  constructor(message: string, nodeIndex?: number) {
    super(message, nodeIndex)
    this.name = 'InvalidActionIdError'
  }
}
