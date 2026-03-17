// Copyright (c) 2026 Wuji Labs Inc
import type { ASTNode } from 'graphql'
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql'

/**
 * A regular expression to validate the specific format of a SystemActionId.
 * Format: `core:${string}` where string contains alphanumeric characters, underscores, and hyphens
 */
const SYSTEM_ACTION_ID_REGEX = /^core:[a-z0-9_-]+$/i

const validate = (value: unknown, ast?: ASTNode) => {
  if (typeof value !== 'string') {
    throw new GraphQLError(
      `Value is not string: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  if (!SYSTEM_ACTION_ID_REGEX.test(value)) {
    throw new GraphQLError(
      `Value is not a valid System Action ID: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  return value
}

export const SystemActionIdScalar = new GraphQLScalarType({
  name: 'SystemActionId',
  description:
    'SystemActionId custom scalar type for core system actions (core:action_name)',
  serialize: validate,
  parseValue: validate,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as System Action IDs but got a: ${ast.kind}`,
        { nodes: ast },
      )
    }

    return validate(ast.value, ast)
  },
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'SystemActionId',
      type: 'string',
      pattern: SYSTEM_ACTION_ID_REGEX.source,
    },
  },
})
