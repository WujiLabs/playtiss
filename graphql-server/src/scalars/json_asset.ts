// Copyright (c) 2026 Wuji Labs Inc
import * as dagJSON from '@ipld/dag-json'
import {
  GraphQLError,
  type GraphQLScalarLiteralParser,
  GraphQLScalarType,
  Kind,
  print,
} from 'graphql'
import type { ValueNode } from 'graphql/language'
import type { AssetValue, DictAsset } from 'playtiss'

type VariablesType = Parameters<GraphQLScalarLiteralParser<unknown>>[1]

// Serialize AssetValue (may contain CID instances / Uint8Arrays) to plain JSON-safe object
function serializeValue(v: unknown): unknown {
  return JSON.parse(new TextDecoder().decode(dagJSON.encode(v as AssetValue)))
}

// Parse plain JSON object (may contain {"/": "cid"} links) to AssetValue with CID instances
function parseJsonValue(v: unknown): AssetValue {
  return dagJSON.decode(new TextEncoder().encode(JSON.stringify(v))) as AssetValue
}

function parseLiteral(
  typeName: string,
  ast: ValueNode,
  variables?: VariablesType,
): AssetValue {
  switch (ast.kind) {
    case Kind.STRING:
      return ast.value
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value)
    case Kind.OBJECT: {
      const obj: Record<string, AssetValue> = {}
      ast.fields.forEach((field) => {
        obj[field.name.value] = parseLiteral(typeName, field.value, variables)
      })
      return parseJsonValue(obj) as DictAsset
    }
    case Kind.LIST:
      return ast.values.map(n => parseLiteral(typeName, n, variables)) as AssetValue[]
    case Kind.NULL:
      return null
    default:
      throw new GraphQLError(
        `${typeName} cannot represent value: ${print(ast)}`,
      )
  }
}

export const JSONAssetScalar = new GraphQLScalarType<AssetValue, unknown>({
  name: 'JSONAsset',
  description:
    'The `JSONAsset` scalar type represents IPLD dag-json values. CID links serialize as {"/": "cidString"}.',
  serialize: serializeValue,
  parseValue: parseJsonValue,
  parseLiteral: (ast, variables) => parseLiteral('JSONAsset', ast, variables),
})

export default JSONAssetScalar

export const DictJSONAssetScalar = new GraphQLScalarType<DictAsset, unknown>({
  name: 'DictJSONAsset',
  description:
    'The `DictJSONAsset` scalar type represents the object (dict) subtype of `JSONAsset`',
  serialize: (v) => {
    const result = serializeValue(v)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new GraphQLError(
        `DictJSONAsset cannot represent non-object value: ${v}`,
      )
    }
    return result
  },
  parseValue: (v) => {
    const result = parseJsonValue(v)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new GraphQLError(
        `DictJSONAsset cannot represent non-object value: ${v}`,
      )
    }
    return result as DictAsset
  },
  parseLiteral: (ast, variables) => {
    if (ast.kind !== Kind.OBJECT) {
      throw new GraphQLError(
        `DictJSONAsset cannot represent non-object value: ${print(ast)}`,
      )
    }
    const obj: Record<string, AssetValue> = {}
    ast.fields.forEach((field) => {
      obj[field.name.value] = parseLiteral('DictJSONAsset', field.value, variables)
    })
    return parseJsonValue(obj) as DictAsset
  },
})
