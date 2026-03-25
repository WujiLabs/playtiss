// Copyright (c) 2026 Wuji Labs Inc
import { GraphQLScalarType } from 'graphql'
import { RegularExpression } from 'graphql-scalars'

/**
 * SystemActionId scalar — core system action identifiers.
 * Format: `core:${string}` where string contains alphanumeric, underscores, hyphens, and dots.
 *
 * Backed by graphql-scalars RegularExpression for validation.
 */
const SYSTEM_ACTION_ID_REGEX = /^core:[a-z0-9_.-]+$/i

export const SystemActionIdScalar = new GraphQLScalarType({
  ...new RegularExpression('SystemActionId', SYSTEM_ACTION_ID_REGEX).toConfig(),
  description: 'SystemActionId custom scalar type for core system actions (core:action_name)',
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'SystemActionId',
      type: 'string',
      pattern: SYSTEM_ACTION_ID_REGEX.source,
    },
  },
})
