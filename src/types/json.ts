// Copyright (c) 2026 Wuji Labs Inc
// Serialization helpers using IPLD dag-json encoding.
// Replaces the old JSONAsset / jsonify / parseAssetText system.
//
// dag-json produces valid JSON where:
//   strings   → plain JSON strings (no double-quoting)
//   CID links → {"/": "cidString"}
//   bytes     → {"/": {"bytes": "base64pad..."}}
//
// encodeToString / decodeFromString are used for SQLite string columns.
import * as dagJSON from '@ipld/dag-json'

export { dagJSON }

export const encodeToString = (v: unknown): string =>
  new TextDecoder().decode(dagJSON.encode(v))

export const decodeFromString = (s: string): unknown =>
  dagJSON.decode(new TextEncoder().encode(s))
