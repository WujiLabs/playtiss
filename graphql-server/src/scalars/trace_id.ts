// Copyright (c) 2026 Wuji Labs Inc
import { GraphQLScalarType } from 'graphql'
import { RegularExpression } from 'graphql-scalars'

/**
 * TraceId scalar — UUID v8 format with embedded timestamp.
 * Format: `XXXXXXXX-XXXX-8XXX-8XXX-XXXXXXXXXXXX`
 *
 * Backed by graphql-scalars RegularExpression for validation.
 */
const TRACE_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i

export const TraceIdScalar = new GraphQLScalarType({
  ...new RegularExpression('TraceId', TRACE_ID_REGEX).toConfig(),
  description: 'TraceId custom scalar type (UUID v8)',
  extensions: {
    codegenScalarType: 'string',
    jsonSchema: {
      title: 'TraceId',
      type: 'string',
      pattern: TRACE_ID_REGEX.source,
    },
  },
})
