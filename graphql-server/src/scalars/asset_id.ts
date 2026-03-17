// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import type { ASTNode } from 'graphql'
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql'

const SHA256_REGEX = /^[a-f0-9]{64}$/i

const validate = (value: unknown, ast?: ASTNode) => {
  if (typeof value !== 'string') {
    throw new GraphQLError(
      `Value is not string: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  if (!SHA256_REGEX.test(value)) {
    throw new GraphQLError(
      `Value is not a valid Asset ID: ${value}`,
      ast ? { nodes: ast } : undefined,
    )
  }

  return value
}

// For serialization (sending data to client), allow null for optional fields
const serialize = (value: unknown) => {
  // Allow null for optional AssetId fields (like Version.asset_content_hash)
  if (value === null || value === undefined) {
    return null
  }
  return validate(value)
}

export const AssetIdScalar = new GraphQLScalarType({
  name: 'AssetId',
  description: 'AssetId custom scalar type (SHA256)',
  serialize: serialize, // Allow null for optional fields during serialization
  parseValue: validate, // Validate inputs strictly
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as Asset IDs but got a: ${ast.kind}`,
        { nodes: ast },
      )
    }

    return validate(ast.value, ast)
  },
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'AssetId',
      type: 'string',
      pattern: SHA256_REGEX.source,
    },
  },
})
