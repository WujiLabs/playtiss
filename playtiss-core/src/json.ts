// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Serialization helpers using IPLD dag-json encoding.
//
// dag-json produces canonical JSON (keys sorted by UTF-8 byte comparison,
// whitespace stripped) where:
//   strings   → plain JSON strings
//   CID links → {"/": "cidString"}
//   bytes     → {"/": {"bytes": "base64pad..."}}
//
// encodeToString / decodeFromString are suitable for any string-typed storage
// (SQLite columns, localStorage, env vars, etc).
import * as dagJSON from '@ipld/dag-json'

export { dagJSON }

export const encodeToString = (v: unknown): string =>
  new TextDecoder().decode(dagJSON.encode(v))

export const decodeFromString = (s: string): unknown =>
  dagJSON.decode(new TextEncoder().encode(s))
