# CLI Developer Tools

This directory contains developer tools for testing and debugging the CLI and workflow system.

## Tools

### Task Management

#### `submit-add-task.ts`
Creates a new task for the "add two numbers" action.

**Usage:**
```bash
npx tsx dev-tools/submit-add-task.ts <A> <B>
```

**Example:**
```bash
npx tsx dev-tools/submit-add-task.ts 5 3
# Creates task to compute 5 + 3 = 8
```

**Note:** Uses GraphQL API for task creation and scheduling (updated in v10 architecture).

### Inspection Tools

#### `inspect-task.ts`
Displays detailed information about a specific task.

**Usage:**
```bash
npx tsx dev-tools/inspect-task.ts <task_id>
```

#### `inspect-version.ts`
Displays information about a specific version.

**Usage:**
```bash
npx tsx dev-tools/inspect-version.ts <version_id>
```

#### `inspect-asset.ts`
Displays the contents of a specific asset.

**Usage:**
```bash
npx tsx dev-tools/inspect-asset.ts <asset_id>
```

#### `list-entities.ts`
Lists various entities in the system (tasks, versions, workflow runs, task execution states).

**Usage:**
```bash
npx tsx dev-tools/list-entities.ts <entity_type> [limit]
```

**Entity Types:**
- `tasks` - List recent tasks
- `versions` - List recent versions  
- `runs` - List recent workflow runs
- `states` - List task execution states (NEW: includes denormalized action_id and expiration tracking)
- `stats` - Show database statistics

**Examples:**
```bash
npx tsx dev-tools/list-entities.ts tasks 10
npx tsx dev-tools/list-entities.ts states 20
npx tsx dev-tools/list-entities.ts stats
```

#### `inspect-execution-state.ts` (NEW)
Displays detailed task execution state information including denormalized columns and expiration tracking.

**Usage:**
```bash
npx tsx dev-tools/inspect-execution-state.ts <task_id>
```

**Features:**
- Shows runtime status and claim information
- Validates denormalized action_id consistency  
- Displays expiration time and claim status
- Provides runnable analysis based on current criteria
- Detects expired claims that can be reclaimed

**Example:**
```bash
npx tsx dev-tools/inspect-execution-state.ts 01977aaa-7b52-8f28-8a82-123456789abc
```

## Workflow Example

1. Create a new task:
   ```bash
   npx tsx dev-tools/submit-add-task.ts 10 15
   ```

2. Schedule the task via GraphQL:
   ```bash
   curl -X POST http://localhost:4000/graphql \
     -H "Content-Type: application/json" \
     -d '{"query": "mutation { scheduleTaskForExecution(taskId: \"<task_id>\") { taskId runtimeStatus } }"}'
   ```

3. Run the worker to process the task:
   ```bash
   python -m playtiss_action_runner.sample_add_two
   ```

4. Inspect the result:
   ```bash
   npx tsx dev-tools/inspect-task.ts <task_id>
   ```