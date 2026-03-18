# Playtiss

**A workflow management system implementing responsive iteration with content-addressable storage.**

> **Alpha release for research and development.**

## Status

This is an early alpha release of the Playtiss AI SDK. The codebase is under active development and not yet recommended for production use.

**Commercial use license available upon request** - contact info@playtiss.com.

We are migrating to a permissive open-source license (MIT/Apache 2.0) as the codebase matures. See the [License](#license) section below.

## Architecture

Playtiss uses a decoupled Engine/Worker architecture with:

- **Content-Addressable Storage (CAS)** - Immutable assets identified by IPLD CIDs (Content Identifiers)
- **TraceID System** - UUID v8-based temporal tracking for all entities
- **Version-Based Data Model** - Immutable versions with typed outputs (OUTPUT, ERROR, REVISION, etc.)
- **Event-Driven Orchestration** - SQLite-based event bus for workflow coordination
- **GraphQL API** - Central communication layer for all components

### Packages

| Package | Description |
|---------|-------------|
| `src/` (playtiss) | Core CAS system, asset management, TraceID generation |
| `graphql-server/` | Central GraphQL API server (SQLite backend) |
| `pipeline-runner/` | Workflow execution engine with event-driven scheduling |
| `typescript-worker/` | TypeScript task execution worker |
| `playtiss-compiler/` | Workflow definition compiler and validator |

## Getting Started

```bash
# Install dependencies
pnpm install

# Build the core package first
cd src && pnpm build

# Start the GraphQL server
cd graphql-server && pnpm start

# Start a worker
cd typescript-worker && pnpm start
```

## License

This project is licensed under [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/).

- **Allowed**: Viewing source, academic use, non-commercial use, sharing with attribution
- **Not allowed**: Commercial use without a separate license agreement

Portions of this software are derived from Keystone, originally developed by Pinscreen, Inc., and are marked accordingly in source file headers.

For commercial licensing, contact **info@playtiss.com**.
