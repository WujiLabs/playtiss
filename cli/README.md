# Playtiss CLI

Command-line interface for the Playtiss Responsive Workflow Kernel.

## Setup

```bash
pnpm install
pnpm build
```

## Usage

```bash
# List available actions
playtiss actions

# Describe a specific action
playtiss actions-describe <action-id>

# Start a workflow execution
playtiss run <action-id> [-i inputs.json]

# Check workflow status
playtiss status <handle-id>

# Submit a player result (triggers stale detection)
playtiss submit-result <handle-id> <node-id> <output.json>

# Mark a task as failed
playtiss fail-task <handle-id> <node-id> -r "reason"

# Rerun a specific node
playtiss rerun-task <handle-id> <node-id>

# Update stale nodes
playtiss update <handle-id> [-n node1 node2]

# List tasks for an action
playtiss tasks-list <action-id>

# List workflow revisions for a task
playtiss runs-list <task-id>
```

All commands accept `-e <url>` to override the GraphQL endpoint (default: `http://localhost:4000/graphql`).

## Development

```bash
pnpm dev              # Run CLI via tsx (no build needed)
pnpm run codegen      # Regenerate GraphQL types from schema
pnpm run type-check   # Type-check without emitting
```

## Dev Tools

See [`dev-tools/README.md`](dev-tools/README.md) for database inspection utilities.
