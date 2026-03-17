// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
// Reference: https://github.com/taion/graphql-type-json/blob/10418fa03875947140d1c0bd8b8de51926252e35/src/index.js

import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
  print,
  type GraphQLScalarLiteralParser,
} from 'graphql'
import type { ObjectValueNode, ValueNode } from 'graphql/language'
import {
  BinaryAssetReference,
  CompoundAssetReference,
  isBinaryAssetId,
  isCompoundAssetId,
  isReference,
  toAssetId,
  type CompoundLazyAsset,
  type DictLazyAsset,
  type LazyAsset,
  type ReferencedAsset,
} from 'playtiss'
import { isQuotedString, jsonify, type DictJSONAsset, type JSONAsset } from 'playtiss/types/json'

type DictReferencedAsset = { [x: string]: ReferencedAsset }

type VariablesType = Parameters<GraphQLScalarLiteralParser<unknown>>[1]

function parseString(value: string) {
  if (isBinaryAssetId(value)) {
    return new BinaryAssetReference(toAssetId(value), null)
  }
  if (isCompoundAssetId(value)) {
    return new CompoundAssetReference<CompoundLazyAsset>(
      toAssetId(value),
      null,
    )
  }
  // double quoted string
  if (isQuotedString(value)) {
    return value.slice(1, -1)
  }
  // Unquoted plain strings are not allowed in JSONAsset format
  throw new GraphQLError(
    `JSONAsset cannot parse unquoted string value: ${value}`,
  )
}

function parseValue(value: unknown): ReferencedAsset {
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) {
    return value.map(v => parseValue(v))
  }
  if (
    typeof value === 'undefined'
    || typeof value === 'function'
    || typeof value === 'symbol'
  ) {
    throw new TypeError(
      `LazyAsset cannot parse ${typeof value} value: ${String(value)}`,
    )
  }
  if (value === null) return null
  if (typeof value === 'string') {
    return parseString(value)
  }
  const obj = Object.fromEntries(
    Object.entries(value).map(([k, v]: [string, unknown]) => [k, parseValue(v)]),
  )
  return obj
}

function ensureJSONObject(value: JSONAsset) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GraphQLError(
      `DictJSONAsset cannot represent non-object value: ${value}`,
    )
  }

  return value
}

function ensureReferencedObject(value: ReferencedAsset) {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isReference(value)
  ) {
    throw new GraphQLError(
      `DictJSONAsset cannot represent non-object value: ${value}`,
    )
  }

  return value
}

function parseObject(
  typeName: string,
  ast: ObjectValueNode,
  variables?: VariablesType,
): DictReferencedAsset {
  const value: DictReferencedAsset = {}
  ast.fields.forEach((field) => {
    value[field.name.value] = parseLiteral(typeName, field.value, variables)
  })

  return value
}

function parseLiteral(
  typeName: string,
  ast: ValueNode,
  variables?: VariablesType,
): ReferencedAsset {
  switch (ast.kind) {
    case Kind.STRING: {
      try {
        return parseString(ast.value)
      }
      catch (e) {
        if (e instanceof TypeError) {
          // rethrow ast for more context
          throw new GraphQLError(
            `${typeName} cannot represent value: ${print(ast)}`,
          )
        }
        throw e
      }
    }
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value)
    case Kind.OBJECT:
      return parseObject(typeName, ast, variables)
    case Kind.LIST:
      return ast.values.map(n => parseLiteral(typeName, n, variables))
    case Kind.NULL:
      return null
    default:
      throw new GraphQLError(
        `${typeName} cannot represent value: ${print(ast)}`,
      )
  }
}

// This named export is intended for users of CommonJS. Users of ES modules
//  should instead use the default export.
export const JSONAssetScalar = new GraphQLScalarType<LazyAsset, JSONAsset>({
  name: 'JSONAsset',
  description:
    'The `JSONAsset` scalar type represents a subset of JSON where serialized string literals are either double-quoted strings or references of binary or compound assets',
  serialize: jsonify,
  parseValue,
  parseLiteral: (ast, variables) => parseLiteral('JSONAsset', ast, variables),
})

export default JSONAssetScalar

export const DictJSONAssetScalar = new GraphQLScalarType<
  DictLazyAsset,
  DictJSONAsset
>({
  name: 'DictJSONAsset',
  description:
    'The `DictJSONAsset` scalar type represents the object (dict) subtype of `JSONAsset`',
  serialize: v => ensureJSONObject(jsonify(v)),
  parseValue: v => ensureReferencedObject(parseValue(v)),
  parseLiteral: (ast, variables) => {
    if (ast.kind !== Kind.OBJECT) {
      throw new GraphQLError(
        `DictJSONAsset cannot represent non-object value: ${print(ast)}`,
      )
    }

    return parseObject('DictJSONAsset', ast, variables)
  },
})
