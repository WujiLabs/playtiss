# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-04-18

### New package: `@playtiss/core` (MIT-licensed)

Extracted the vocabulary of the Playtiss Collaboration Protocol into a new MIT-licensed
package, `@playtiss/core`, published from `playtiss-core/`. The SDK (`playtiss`, this
package, CC BY-NC 4.0) now consumes the vocabulary from core rather than owning it.

**Contents of `@playtiss/core` v0.1.0-alpha.0:**

- **Primitives**: `AssetId`, `TaskId`, `VersionId`, `UserActionId`, `SystemActionId`, `ActionId`, `ScopeId`, `TraceId`, `ValueOrLink<T>`, `NamespacedActionId<Prefix>`
- **Content-addressing**: `AssetValue`, `DictAsset`, `CID`, `PlaytissLink`, `DagJsonLink`, `RawLink`, `isLink`, `isAssetId`
- **Hashing**: `computeHash`, `computeTopBlock`, `cidToAssetId`
- **Serialization**: `encodeToString`, `decodeFromString`, `dagJSON`
- **IDs**: `generateTraceId`, `generateTraceIdBytes`, `generateOperationId`, `parseTraceId`, `isTraceId`, `TraceIdGenerator`
- **Graph primitives**: `Graph`, `GraphNode`, `GraphEdge` (flat ReactFlow-style edges adapted from `@xyflow/react`)
- **Relationship generics**: `TaskLike`, `VersionLike`, `ActionLike`, `DefaultTask`, `DefaultVersion`, `DefaultAction`, `isSystemAction`
- **Storage interface**: `StorageProvider`, `AssetReferences` (generic; SDK widens with workflow-specific refs)

### Breaking Changes

- **Edge model flattened**: `Pipeline.Edge` changed from nested `{source: {node, name}, target: {node, name}}` to flat `{source, sourceHandle, target, targetHandle}` satisfying `GraphEdge` from core. **CIDs of edge-containing workflows have changed** — regenerate any test fixtures or persisted pipelines. No dual-parse shim; old shape is not readable.
- **`Pipeline extends Graph`**: Pipeline is now a concrete narrowing of the generic `Graph` from core. Any Graph consumer (proxy, visualizer, third-party harness) can process a Pipeline through the shared primitive.
- **Core types no longer exported from `playtiss` barrel**. The following moved to `@playtiss/core`:
  - **Types**: `AssetId`, `AssetValue`, `DictAsset`, `CID`, `DagJsonLink`, `RawLink`, `PlaytissLink`, `TraceId`, `TraceIdGenerator`, `TaskId`, `VersionId`, `UserActionId`, `SystemActionId`, `ActionId`, `ScopeId`, `NamespacedActionId<Prefix>`, `ValueOrLink<T>`
  - **Functions / guards**: `isAssetId`, `isLink`, `isTraceId`, `isSystemAction`, `generateTraceId`, `generateTraceIdBytes`, `generateOperationId`, `parseTraceId`, `computeHash`, `computeTopBlock`, `cidToAssetId`, `encodeToString`, `decodeFromString`
  - **Storage contract**: `StorageProvider`, generic `AssetReferences`
  - Update imports:
    - `import type { AssetId } from 'playtiss'` → `import type { AssetId } from '@playtiss/core'`
    - `import { generateTraceId } from 'playtiss/types/trace_id'` → `import { generateTraceId } from '@playtiss/core'`
    - `import { encodeToString } from 'playtiss/types/json'` → `import { encodeToString } from '@playtiss/core'`
    - `import type { StorageProvider } from 'playtiss/asset-store'` → `import type { StorageProvider } from '@playtiss/core'`
    - `import { computeHash } from 'playtiss/asset-store'` → `import { computeHash } from '@playtiss/core'`
- **Relationship generics replace concrete Task/Version/Action in core**: Core ships `TaskLike<TId, TActionId, TInput, TVersionId>`, `VersionLike<TVersionId, TTaskId, TAsset>`, and `ActionLike<T extends TaskLike<...>>`. The SDK's concrete `Task`, `Version`, `Action` shapes live in `playtiss` and satisfy these generics — machine-checkable via `type _ok = Task extends TaskLike<...> ? true : never`.
- **`SystemActionId` type**: moved to `@playtiss/core`; the concrete `SYSTEM_ACTIONS` registry remains in `playtiss/system-actions`.
- **Removed sub-path exports from `playtiss`**: `playtiss/types/json`, `playtiss/types/trace_id`, `playtiss/types/playtiss`, `playtiss/types/text` are gone. Use `@playtiss/core` directly.
- **`trace-id` now throws on missing Web Crypto API**: the `Math.random` fallback is deleted. Any runtime without `crypto.getRandomValues` fails loud at `generateTraceId()` instead of silently downgrading to non-cryptographic randomness.
- **`getTime()` helper removed** from the `playtiss` barrel (was dead code).

### Changed

- **License boundary**: `@playtiss/core` is MIT; `playtiss` (the SDK) remains CC BY-NC 4.0. The split is the infrastructure for the Collaboration Protocol thesis — any third-party tool that wants to emit vocabulary-compliant DAGs depends on the MIT layer without taking on the NC-licensed SDK.
- **Pipeline file header**: `src/pipeline/index.ts` no longer carries the Pinscreen attribution. The Edge rewrite and Graph primitive extraction together remove the residual structural overlap with prior-art upstream code; the file is now fully Wuji Labs copyright.
- **pnpm workspace**: added `playtiss-core` as a workspace member; root build script builds core first.
- **Test coverage**: 69 tests in `@playtiss/core` (trace-id bit layout, json roundtrip, graph CID stability, hash Merkle-ization, relationship-generic conformance). Integration test (`scripts/integration-test.sh`) passes all 13 assertions end-to-end.
- **Test DB regenerated**: `graphql-server/playtiss-test-add3.db` rebuilt with new edge shape; action IDs refreshed in `scripts/integration-test.sh`, `pipeline-runner/src/index.ts`, and `typescript-worker/src/sample_add_two.ts`.

### Removed

- **Dead pipeline slot types**: `EdgeSourceSlot`, `EdgeTargetSlot`, `NodeInputSlot`, `NodeOutputSlot`, `PipelineInputSlot`, `PipelineOutputSlot` — all obsolete after the edge flattening.
- **`createSystemActionId` helper**: was a one-line type cast; callers can cast inline.
- **`src/types/asset_id.ts`, `asset_value.ts`, `json.ts`, `trace_id.ts`**: moved to `@playtiss/core/src/`.
- **`src/asset-store/compute_hash.ts`, `storage-provider.ts`**: moved to `@playtiss/core/src/`.

## [0.4.0] - 2026-03-26

### Breaking Changes

- **Pipeline type modernization**: Removed `asset_type`, `use_task_creator`, `timestamp` from Node/Edge/Pipeline types. These fields were set but never read by any code.
- **Node/edge keys**: `Record<AssetId, Node>` → `Record<TraceId, Node>`. Pipeline node and edge maps now use TraceId (UUID v8) keys instead of content-hash AssetId keys. Edge slot `node` references updated accordingly.
- **JSON Schema**: `Pipeline.input_shape`/`output_shape` → `Pipeline.input_schema`/`output_schema` (JsonSchema type). Action type updated similarly.
- **Database**: Migrated from async `sqlite3` to synchronous `better-sqlite3` across the entire monorepo.
- **getProfile query removed**: Deleted Profile type, getProfile query, and resolver (stub returning hardcoded "Default User").

### Changed

- **Seed script**: Uses `generateTraceId()` for node/edge keys instead of `store()`.
- **Compiler**: Uses `generateTraceId()` for node/edge keys, removed dead field assignments.
- **Pipeline GraphQL client**: Removed dead `subscribeToTaskExecution()`, `watchTask()`, `pipelineGraphQLClient` singleton. Removed all stale "Replaces:" and "V12" comments.
- **ESLint**: Added `eslint-plugin-simple-import-sort`, `no-unused-vars` with `_` prefix allowance. Eliminated all `catch (error: any)` with proper `instanceof Error` checks. Typed `createApolloServer()` generics. Added `globals` for scripts. Import-sorted 50+ files.
- **S3 error handling**: Use `S3ServiceException.isInstance()` for proper error discrimination instead of `error.name` checks on `any`.

### Removed

- Dead fields: `Node.asset_type`, `Node.use_task_creator`, `Node.timestamp`, `Edge.asset_type`, `Pipeline.asset_type`, `Pipeline.timestamp`.
- Dead methods: `subscribeToTaskExecution()`, `watchTask()`, `TASK_EXECUTION_UPDATED` subscription.
- Dead export: `pipelineGraphQLClient` singleton.
- Dead query: `getProfile` / `Profile` type.
- Unused imports across all packages.

## [0.3.0] - 2026-03-25

### Breaking Changes

- **Event handler renames**: `onPipelineClaimed` → `handleWorkflowStart`, `onTaskDelivered` → `handleTaskCompletion`, `onTaskAborted` → `handleTaskFailure`, `onTaskUpdated` → `handleTaskProgress`.
- **Model function renames**: `createPendingTaskRecord` → `createPartialTaskInputs`, `deletePendingTask` → `deletePartialTaskInputs`, `getPendingTaskInputs` → `getPartialTaskInputs`, `updateAndRetrieveTaskMergeAsset` → `updatePartialTaskInputs`.
- **PendingTask type removed**: Handlers now return `Task | null` instead of `Task | PendingTask | null`. The `PendingTask` type, `collectTasks()`, and `isTask()` guard are deleted.
- **NodeSlotInfo fields renamed**: `tag_edges` → `context_edges`, `slot_edges` → `data_edges`.
- **TypeScript worker function renames**: `taskRunner` → `runWorkerLoop`, `handleNewTask` → `executeTask`, `mandatoryTaskRunner` → `executeSingleTask`. `TaskPool` class deleted.
- **Database**: Migrated from async `sqlite3` to synchronous `better-sqlite3` across the entire monorepo.

### Added

- **Caret (^) meta slot type**: 3rd slot type for hash-transparent metadata pass-through. Meta values bypass both `inputs_content_hash` and `context_asset_hash` while gating merge readiness. Persisted via `meta_asset_hash` column on `WorkflowRevisionNodeStates`.
- **Split/merge integration test**: Step 7 in integration-test.sh exercises split→add_two→merge workflow end-to-end (3 nodes, 9 edges). All 13 assertions pass.
- **ESLint import sorting**: Added `eslint-plugin-simple-import-sort` for consistent import ordering.
- **Narrowed context types**: `V12Context` narrowed to `{ [key: \`%${string}\`]: AssetValue }`, `MetaValues` to `{ [key: \`^${string}\`]: AssetValue }`.

### Changed

- **Parser rewrite**: Declarative graph-builder (`buildAdjacency` → `classifyNodeTypes` → `buildDownstreamMap` → `extractSlotNames`) replaces imperative single-pass edge iteration.
- **Scheduler rewrite**: Strategy map replaces switch statement. Extracted `resolveContextEdges`, `resolveDataEdges`, `resolveMetaEdges`. All function names renamed.
- **Runner rewrite**: `TaskPool` replaced with `p-limit` + `Set<string>`. Nested try/catch flattened to linear async flow.
- **Scalars simplified**: Date scalar uses `graphql-scalars` Timestamp. TraceId, ActionId, SystemActionId use `RegularExpression` factory. AssetId simplified (CID.parse kept). Fixed SystemActionId regex to allow dots.
- **Utility types simplified**: `At<>`/`PathsIn<>`/`KeysIn<>` utility types replaced with direct `NonNullable<>` extractions in both pipeline-runner and typescript-worker.
- **Integration test**: Now runs `pnpm build` at root instead of only building the playtiss package.

### Removed

- **Dead code**: `updateTaskStatus()` no-op function. `PendingTaskTableRecord` type. `taskMergeAction` constant. Unused imports across all packages.
- **Auth layer**: `auth/user.ts`, login mutation, jsonwebtoken dependency (constructed but never consumed).
- **promise_map utility**: Replaced with `pLimit()` + `Promise.all()` and plain `for...of` loops.
- **Pinscreen attribution headers**: Removed from 7 files with no derivative overlap. Retained on `scheduler.ts` and `pipeline/index.ts`.

## [0.2.1] - 2026-03-24

### Fixed

- Fix IPLD content-addressing bugs (`store()` persisting Merkle bytes instead of original value)
- Fix integration test for CID-based node ordering

### Changed

- Eliminate `legacy.ts` — remove last derivative types
- Clean up phase1-cli → cli/ (delete derivative phase1-replay.ts, fix broken imports, add copyright headers)

### Added

- Integration test infrastructure exercising full E2E workflow (6 steps, 11 assertions)

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
