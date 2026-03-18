# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0-alpha] - 2026-03-17

### Breaking Changes

- **Asset ID format**: Asset identifiers are now IPLD CIDs (Content Identifiers) using base32 multihash encoding, replacing the previous SHA-256 hex format. Existing assets stored under the old hex format are not directly compatible.

### Changed

- **Content addressing**: Replaced custom SHA-256 hashing (`compute_hash.ts`) with IPLD Block API (`@ipld/dag-json` + Merkle flattening). Asset serialization now uses `dag-json` for canonical encoding.
- **Asset ID validation**: `isAssetId()` now validates CID format instead of hex regex.
- **JSON asset types**: `jsonify()` / `parseAssetText()` now delegate to `dag-json` encode/decode.
- **Storage backends**: Merged standalone storage functions into `LocalStorageProvider` and `S3StorageProvider` class methods. The separate `local/store.ts` and `s3/store.ts` files have been eliminated.

### Removed

- **Reference classes**: `src/types/reference.ts` and all `Reference<T>` / `CompoundAssetReference<T>` classes — replaced by direct CID linking.
- **Legacy hash functions**: `computeBinaryHash`, `computeStringHash`, `stringify`, `toLiteral`, `toHashable` — replaced by `computeTopBlock()` and IPLD block operations.

## [0.1.0-alpha] - 2026-03-17

### Added

- Initial alpha release based on Keystone codebase with Pinscreen copyright headers.
- Core CAS system, GraphQL API server, pipeline runner, TypeScript worker, compiler.
- TraceID system (UUID v8), event-driven orchestration, version-based data model.
- Creative Commons BY-NC 4.0 license for source-available distribution.
