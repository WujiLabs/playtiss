// Copyright (c) 2026 Wuji Labs Inc
/**
 * TypeScript worker domain types extracted from GraphQL codegen output.
 * Direct NonNullable<> extractions replace the At<>/PathsIn<>/KeysIn<> utility.
 */
import type {
  CreateVersionMutation,
  GetTaskQuery,
} from './__generated__/graphql.js'

/** Task record as returned by getTask query */
export type Task = NonNullable<GetTaskQuery['getTask']>

/** Version record as returned by createVersion mutation */
export type Version = NonNullable<CreateVersionMutation['createVersion']>
