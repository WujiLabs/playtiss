// Copyright (c) 2026 Wuji Labs Inc
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql'
import { CID } from 'multiformats/cid'

/**
 * AssetId scalar — Content Identifier (CID) from the IPLD/multiformats ecosystem.
 * Validated via CID.parse() which checks multibase prefix, multicodec, and multihash.
 *
 * Cannot use graphql-scalars RegularExpression because CID validation is structural,
 * not pattern-based. However, the serialize/parseValue/parseLiteral structure follows
 * the same validate-or-throw pattern.
 */
function validateCID(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GraphQLError(`AssetId expected string, got: ${typeof value}`)
  }
  try {
    CID.parse(value)
  }
  catch {
    throw new GraphQLError(`Value is not a valid Asset ID (CID): ${value}`)
  }
  return value
}

export const AssetIdScalar = new GraphQLScalarType({
  name: 'AssetId',
  description: 'AssetId custom scalar type (IPLD Content Identifier)',
  serialize(value) {
    // Allow null for optional AssetId fields (e.g. Version.asset_content_hash)
    if (value === null || value === undefined) return null
    return validateCID(value)
  },
  parseValue: validateCID, // Strict — inputs must be valid CID strings
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`AssetId expected string literal, got: ${ast.kind}`, { nodes: ast })
    }
    return validateCID(ast.value)
  },
  extensions: {
    codegenScalarType: 'string',
  },
})
