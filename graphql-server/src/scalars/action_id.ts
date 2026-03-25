// Copyright (c) 2026 Wuji Labs Inc
import { GraphQLScalarType } from 'graphql'
import { RegularExpression } from 'graphql-scalars'

/**
 * ActionId scalar — accepts either TraceId (UUID v8) or SystemActionId (core:action_name).
 * Combined regex with alternation to validate both formats in a single pass.
 *
 * Backed by graphql-scalars RegularExpression for validation.
 */
const ACTION_ID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}|core:[a-z0-9_.-]+)$/i

export const ActionIdScalar = new GraphQLScalarType({
  ...new RegularExpression('ActionId', ACTION_ID_REGEX).toConfig(),
  description: 'ActionId custom scalar type that accepts either TraceId (UUID v8) or SystemActionId (core:action_name)',
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'ActionId',
      type: 'string',
      pattern: ACTION_ID_REGEX.source,
    },
  },
})
