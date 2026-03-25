// Copyright (c) 2026 Wuji Labs Inc
import { GraphQLScalarType } from 'graphql'
import { GraphQLTimestamp } from 'graphql-scalars'

/**
 * Date scalar backed by graphql-scalars Timestamp.
 * Serializes Date objects and numbers to epoch milliseconds (integer).
 * Parses incoming integers to Date objects.
 *
 * We keep the schema name "Date" for API compatibility while delegating
 * all serialize/parse logic to the well-tested graphql-scalars package.
 */
export const DateScalar = new GraphQLScalarType({
  ...GraphQLTimestamp.toConfig(),
  name: 'Date',
  description: 'Date as milliseconds since UNIX epoch (backed by graphql-scalars Timestamp)',
})
