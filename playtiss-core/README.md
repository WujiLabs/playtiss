# @playtiss/core

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The vocabulary of the Playtiss Collaboration Protocol.**

Content-addressed DAG primitives where human and AI nodes are peer editors of the same workflow. Any tool that participates in the Collaboration Protocol — a proxy, a harness integration, a visualizer, a cross-substrate identity layer — imports `@playtiss/core` for its type definitions, graph primitives, and CID computation.

MIT-licensed, published from the `playtiss-core/` directory of [WujiLabs/playtiss](https://github.com/WujiLabs/playtiss).

## Install

```bash
npm install @playtiss/core
```

## What's inside

| Concern | Exports |
|---------|---------|
| **Primitive ids** | `AssetId`, `TraceId`, `TaskId`, `VersionId`, `UserActionId`, `SystemActionId`, `ActionId`, `ScopeId`, `NamespacedActionId<Prefix>`, `ValueOrLink<T>` |
| **Content-addressing** | `AssetValue`, `DictAsset`, `CID`, `PlaytissLink`, `DagJsonLink`, `RawLink`, `isLink`, `isAssetId` |
| **Hashing** | `computeHash`, `computeTopBlock`, `cidToAssetId` |
| **Serialization** | `encodeToString`, `decodeFromString`, `dagJSON` |
| **IDs** | `generateTraceId`, `generateTraceIdBytes`, `generateOperationId`, `parseTraceId`, `isTraceId`, `TraceIdGenerator` |
| **Graph primitives** | `Graph`, `GraphNode`, `GraphEdge` (flat ReactFlow-style edges) |
| **Relationship generics** | `TaskLike`, `VersionLike`, `ActionLike`, `DefaultTask`, `DefaultVersion`, `DefaultAction`, `isSystemAction` |
| **Storage interface** | `StorageProvider`, `AssetReferences` |
| **Storage operations** | `store`, `load`, `resolve`, `computeStorageBlock` (parameterized by a `StorageProvider`) |
| **Channel substrate** (`@playtiss/core/channel`) | `createChannel`, `migrate`, `applyTask`, `taskRef`, `isTaskRef`, `Channel`, `Task`, `TaskRef`, `Outcome`, `SubmitResult`, `SqliteStorageProvider` |

## Quickstart

### Hash an object

```ts
import { computeHash } from '@playtiss/core'

const cid = await computeHash({ hello: 'world' })
// "bafyreia..."
```

Keys are sorted (dag-json canonical form), so insertion order does not affect the CID.

### Build a graph

```ts
import { generateTraceId } from '@playtiss/core'
import type { Graph, GraphNode, GraphEdge } from '@playtiss/core'

const n1 = generateTraceId()
const n2 = generateTraceId()
const e1 = generateTraceId()

const graph: Graph = {
  nodes: {
    [n1]: { action: 'my_namespace:produce' },
    [n2]: { action: 'my_namespace:consume' },
  },
  edges: {
    [e1]: {
      source: n1,
      target: n2,
      sourceHandle: 'output',
      targetHandle: 'input',
    },
  },
}
```

### Persist + retrieve content-addressed assets

```ts
import { store, load, resolve } from '@playtiss/core'
import type { StorageProvider } from '@playtiss/core'

// Implement the byte-level storage contract for your environment
// (SQLite, IndexedDB, S3, an in-memory Map, etc).
const provider: StorageProvider = mySqliteOrFsOrS3Adapter

const id = await store({ role: 'user', content: 'hello' }, provider)
// → "bafyrei..."  Merkle CID; same logical input → same CID, idempotent.

const value = await load(id, provider)
// → AssetValue with CID instances inline (links not pre-resolved).

const fullyMaterialized = await resolve(value, provider)
// → recursively follows every CID link until no links remain.
```

`store` writes ONE blob per call (the inline encoding); the CID is computed Merkle-style so two equivalent logical values produce the same CID regardless of whether sub-fields are inline or already CID-linked. `load` returns `AssetValue` with `CID` instances preserved inline so comparison-only callers don't pay for sub-block I/O. `resolve` is opt-in materialization. There's also `computeStorageBlock(value)` if you need to pre-compute `{cid, bytes}` for a batched write outside the normal `provider.saveBuffer` flow (e.g., inside a sync DB transaction).

### Channel substrate (`@playtiss/core/channel`)

The reference implementation of the Collaboration Protocol's substrate primitives: an append-only event log, content-addressed blob storage, and Task-shaped projector dispatch over SQLite. Optional subpath — only loaded if you import `@playtiss/core/channel`. `better-sqlite3` is an optional peer dependency consumers install only if they use the channel.

Protocol mapping (L2/L3/L4):

- **L2.2 Immutable Value** — `blobs` table, content-addressed via the same CID computation used by `store`/`load`/`resolve`.
- **L2.3 Reference** — the `events` table is the binding-history substrate per topic, per session.
- **L2.4 Resolution** — `Channel.submit()` dispatches each subscribed Task's `apply()`. Each Task returns an `Outcome` (`accept` or `exception`); all outcomes are recorded. Exceptions roll back the projector's partial writes via a per-Task SAVEPOINT, then land as a `projection.exception` event so the L1.10 Explicit Discarding invariant holds.
- **L3.5 Task** — `applyTask(action, input)` produces a content-hashed `TaskId`. Same `(action, input)` → same TaskId across processes, so a Task's identity is its declared shape, not a registry-issued handle.
- **L4 Submit** — `submit(topic, payload, sessionId, referencedBlobs?)` is async by interface. Local SQLite resolves on the same microtask; a future cross-process implementation can swap in without breaking callers.

```ts
import { createChannel, migrate, applyTask, taskRef } from '@playtiss/core/channel'
import Database from 'better-sqlite3'

const db = new Database('./data.db')
migrate(db) // channel-owned tables: blobs, events, task_metadata, channel_schema_version

const sessionsTaskId = await applyTask('myapp.sessions_v1', { topics: ['session.opened'] })
const revisionsTaskId = await applyTask('myapp.revisions_v1', {
  topics: ['proxy.request_received', 'proxy.response_completed'],
  sessions: taskRef(sessionsTaskId), // declarative dependency — runner topo-sorts on this
})

const channel = createChannel({
  db,
  tasks: [
    { id: sessionsTaskId, action: 'myapp.sessions_v1', input: {...}, apply: (event, tx) => {...} },
    { id: revisionsTaskId, action: 'myapp.revisions_v1', input: {...}, apply: (event, tx) => {...} },
  ],
})

const { event, outcomes } = await channel.submit('proxy.request_received', { ... }, sessionId)
```

Dependency edges are declared inside each Task's `input` dict via `taskRef(otherTaskId)` values. The runner walks the dict, harvests every TaskRef, and topologically sorts. Register out of order; dispatch still runs in dep order. Cycles or unregistered refs throw at first `submit()`.

Channel migrations track a separate `channel_schema_version` table from the consumer's own schema. Consumers call `channel.migrate(db)` first, then run their own migrations on top — channel-version bumps don't force consumer code changes.

What the channel does NOT do in v0.3: subscribe()-side cursor reads, `propose`/`resolve`/`setResolver` for non-trivial resolution, the `ref(name)` compositional primitive, async projector apply(). Deferred to v0.4 when a consumer needs them.

### Conform to the protocol

Third-party tools define their own concrete Task / Version / Action shapes and assert they satisfy the core generics at compile time:

```ts
import type {
  TaskLike, TaskId, ActionId, VersionId,
  ValueOrLink, DictAsset,
} from '@playtiss/core'

export type MyTask = TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, VersionId> & {
  // any additional fields your implementation needs
  created_at: number
  name: string
}

// Compile-time check: build fails if MyTask drifts from TaskLike
type _conforms = MyTask extends TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, VersionId> ? true : never
```

See [src/task.ts](./src/task.ts) for the full generic definitions.

## Edge model

`GraphEdge` uses the ReactFlow convention (`@xyflow/react`, MIT):

```ts
interface GraphEdge {
  source: TraceId | null       // null = enclosing graph's input boundary
  target: TraceId | null       // null = enclosing graph's output boundary
  sourceHandle: string | null  // null = default port
  targetHandle: string | null
}
```

Nullable `source` / `target` is our one extension to ReactFlow — it expresses the graph-level input/output boundary without requiring a distinct "graph input" node type. See [src/graph.ts](./src/graph.ts) for the full attribution and rationale.

## Why MIT

The SDK (`playtiss`) that implements this vocabulary is CC BY-NC 4.0. The core vocabulary is MIT so any third-party tool — open source or commercial — can emit protocol-compliant graphs without license friction. The license boundary is structural: you can depend on this package in any commercial context.

## Status

`v0.2.0-alpha` — shape may change before `0.2.0`. Pin exact versions if you care about stability during this window.

`store / load / resolve / computeStorageBlock` moved here from the SDK (`playtiss/asset-store`) in 0.2.0-alpha.0. The SDK still exports the same surface as a thin wrapper over the global `StorageProvider` singleton, so existing SDK consumers keep working unchanged.

`@playtiss/core/channel` ships as a reference implementation of the Collaboration Protocol's substrate primitives. Used by `@playtiss/retcon` (the Observer Actor instantiation). The shape is small on purpose — v0.3 is the minimum needed for retcon; v0.4 adds `subscribe()` cursor reads when arianna or another second consumer lands.

## License

MIT © 2026 Wuji Labs Inc
