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

`v0.1.0-alpha` — shape may change before `0.1.0`. Pin exact versions if you care about stability during this window.

## License

MIT © 2026 Wuji Labs Inc
