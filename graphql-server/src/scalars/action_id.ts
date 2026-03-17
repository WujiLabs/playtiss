// Copyright (c) 2026 Wuji Labs Inc
import type { ASTNode } from 'graphql'
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql'

/**
 * Regular expressions for the two possible ActionId formats:
 * 1. TraceId: UUID v8 format (XXXXXXXX-XXXX-8XXX-8XXX-XXXXXXXXXXXX)
 * 2. SystemActionId: core:action_name format
 */
const TRACE_ID_REGEX
  = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i
const SYSTEM_ACTION_ID_REGEX = /^core:[a-z0-9_-]+$/i

const validate = (value: unknown, ast?: ASTNode) => {
  if (typeof value !== 'string') {
    throw new GraphQLError(
      `Value is not string: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  // Check if it matches TraceId format
  if (TRACE_ID_REGEX.test(value)) {
    return value
  }

  // Check if it matches SystemActionId format
  if (SYSTEM_ACTION_ID_REGEX.test(value)) {
    return value
  }

  throw new GraphQLError(
    `Value is not a valid Action ID (must be either TraceId or SystemActionId): ${value}`,
    ast ? { nodes: ast } : undefined,
  )
}

export const ActionIdScalar = new GraphQLScalarType({
  name: 'ActionId',
  description:
    'ActionId custom scalar type that accepts either TraceId (UUID v8) or SystemActionId (core:action_name)',
  serialize: validate,
  parseValue: validate,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as Action IDs but got a: ${ast.kind}`,
        { nodes: ast },
      )
    }

    return validate(ast.value, ast)
  },
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'ActionId',
      type: 'string',
      oneOf: [
        {
          pattern: TRACE_ID_REGEX.source,
          description: 'TraceId format (UUID v8)',
        },
        {
          pattern: SYSTEM_ACTION_ID_REGEX.source,
          description: 'SystemActionId format (core:action_name)',
        },
      ],
    },
  },
})
