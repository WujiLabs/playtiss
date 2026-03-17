// Copyright (c) 2026 Wuji Labs Inc
import type { ASTNode } from 'graphql'
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql'

/**
 * A regular expression to validate the specific format of a Playtiss TraceID.
 * It expects a UUID string where the version is 8 and the variant bits
 * combined with the reserved bits also result in the 9th byte starting with '8'.
 * Format: `XXXXXXXX-XXXX-8XXX-8XXX-XXXXXXXXXXXX`
 */
const TRACE_ID_REGEX
  = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i

const validate = (value: unknown, ast?: ASTNode) => {
  if (typeof value !== 'string') {
    throw new GraphQLError(
      `Value is not string: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  if (!TRACE_ID_REGEX.test(value)) {
    throw new GraphQLError(
      `Value is not a valid Trace ID: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  return value
}

export const TraceIdScalar = new GraphQLScalarType({
  name: 'TraceId',
  description: 'TraceId custom scalar type (UUID v8)',
  serialize: validate,
  parseValue: validate,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as Trace IDs but got a: ${ast.kind}`,
        { nodes: ast },
      )
    }

    return validate(ast.value, ast)
  },
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'TraceId',
      type: 'string',
      pattern: TRACE_ID_REGEX.source,
    },
  },
})
