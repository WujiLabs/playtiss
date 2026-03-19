#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc

// Load environment variables before any other imports
import dotenv from 'dotenv'
dotenv.config()

import { ApolloClient, InMemoryCache } from '@apollo/client/index.js'
import chalk from 'chalk'
import { Command } from 'commander'
import { existsSync, readFileSync } from 'fs'
import type { ActionId, AssetId, AssetValue, DictAsset, TraceId } from 'playtiss'
import { isAssetId } from 'playtiss'
import { store } from 'playtiss/asset-store'
import { encodeToString, decodeFromString } from 'playtiss/types/json'
import { isTraceId } from 'playtiss/types/trace_id'

// Compatibility aliases for the IPLD migration
type DictLazyAsset = DictAsset
type LazyAsset = AssetValue
import type {
  ListActionsQuery,
  ListRunsForTaskQuery,
  ListTasksByActionQuery,
} from './__generated__/graphql.js'
import {
  FAIL_PLAYER_TASK,
  GET_ACTION_DETAILS,
  GET_WORKFLOW_RUN_STATUS,
  LIST_ACTIONS,
  LIST_RUNS_FOR_TASK,
  LIST_TASKS_BY_ACTION,
  REQUEST_EXECUTION,
  REQUEST_NODE_RERUN,
  REQUEST_STALE_NODES_UPDATE,
  SUBMIT_PLAYER_INPUT,
} from './graphql/queries.js'
const ensureTraceId = (id: string): TraceId => {
  if (!isTraceId(id)) {
    throw new Error(`Invalid trace ID: ${id}`)
  }
  return id
}

const parseContextId = async (id: string | undefined): Promise<AssetId> => {
  if (!id) {
    return await store({})
  }
  if (!isAssetId(id)) {
    throw new Error(`Invalid context ID: ${id}`)
  }
  return id
}

const program = new Command()

// GraphQL client setup
const createClient = (endpoint?: string) => {
  return new ApolloClient({
    uri:
      endpoint
      || process.env.PLAYTISS_GRAPHQL_ENDPOINT
      || 'http://localhost:4000/graphql',
    cache: new InMemoryCache(),
  })
}

program
  .name('playtiss')
  .description('Playtiss CLI - Responsive Workflow Kernel')
  .version('1.0.0')

program
  .command('run')
  .description('Start a new workflow task')
  .argument('<action-id>', 'Action ID to execute')
  .option('-i, --inputs <file>', 'Path to inputs JSON file')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (actionId: string, options: { inputs?: string, endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      let input: LazyAsset = {}
      if (options.inputs) {
        if (!existsSync(options.inputs)) {
          console.error(
            chalk.red(`Error: Inputs file '${options.inputs}' not found`),
          )
          process.exit(1)
        }
        input = decodeFromString(readFileSync(options.inputs, 'utf-8')) as DictAsset
      }

      console.log(chalk.blue(`Starting execution for action: ${actionId}`))

      // v12 Handle-Based API: requestExecution returns a Handle ID
      const result = await client.mutate({
        mutation: REQUEST_EXECUTION,
        variables: { actionId: actionId as ActionId, input: input as DictAsset },
      })

      const handleId = result.data?.requestExecution
      if (!handleId) {
        console.error(chalk.red('Error: Failed to request execution'))
        process.exit(1)
      }
      console.log(chalk.green(`✓ Execution requested: ${handleId}`))
      console.log(
        chalk.gray(`Use 'playtiss status ${handleId}' to check progress`),
      )

      // Poll for initial status
      console.log(chalk.blue('\nFetching initial status...'))
      const statusResult = await client.query({
        query: GET_WORKFLOW_RUN_STATUS,
        variables: { handleId },
        fetchPolicy: 'network-only',
      })

      const run = statusResult.data?.getWorkflowRevisionStatus
      if (run) {
        console.log(chalk.gray(`Status: ${run.status}`))

        // Show initial node states if available
        if (run.nodes && run.nodes.length > 0) {
          console.log(chalk.blue('\nInitial node states:'))
          for (const node of run.nodes) {
            const status = `${node.dependencyStatus}/${node.runtimeStatus}`
            console.log(chalk.gray(`  ${node.nodeIdInWorkflow}: ${status}`))
          }
        }
      }
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('status')
  .description('Get the status of a workflow execution')
  .argument('<handle-id>', 'Execution Handle ID')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (handleId: string, options: { endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      const result = await client.query({
        query: GET_WORKFLOW_RUN_STATUS,
        variables: { handleId: ensureTraceId(handleId) },
        fetchPolicy: 'network-only',
      })

      const run = result.data?.getWorkflowRevisionStatus

      if (!run) {
        console.error(chalk.red(`Error: Execution '${handleId}' not found`))
        process.exit(1)
      }

      console.log(chalk.blue(`\nWorkflow Revision: ${run.id}`))
      console.log(chalk.blue(`Status: ${run.status}`))

      if (run.nodes && run.nodes.length > 0) {
        console.log(chalk.blue('\nNodes:'))

        for (const node of run.nodes) {
          const status = `${node.dependencyStatus}/${node.runtimeStatus}`

          // Color code based on status
          let statusColor = chalk.gray
          if (node.runtimeStatus === 'FAILED') statusColor = chalk.red
          else if (node.runtimeStatus === 'RUNNING') statusColor = chalk.blue
          else if (node.dependencyStatus === 'STALE')
            statusColor = chalk.yellow
          else if (
            node.dependencyStatus === 'FRESH'
            && node.runtimeStatus === 'IDLE'
          )
            statusColor = chalk.green

          console.log(
            `  ${chalk.cyan(node.nodeIdInWorkflow)}: ${statusColor(status)}`,
          )
        }
      }
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('update')
  .description('Update stale nodes in a workflow execution')
  .argument('<handle-id>', 'Execution Handle ID')
  .option(
    '-n, --nodes <nodeIds...>',
    'Specific node IDs to update (space-separated). If omitted, updates all stale nodes.',
  )
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (handleId: string, options: { nodes?: string[], endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      console.log(chalk.blue(`\nRequesting update for workflow: ${handleId}`))
      if (options.nodes) {
        console.log(chalk.blue(`Target nodes: ${options.nodes.join(', ')}`))
      }
      else {
        console.log(chalk.blue(`Target: All stale nodes`))
      }

      const result = await client.mutate({
        mutation: REQUEST_STALE_NODES_UPDATE,
        variables: {
          handleId: ensureTraceId(handleId),
          nodeIds: options.nodes || null,
        },
      })

      const jobId = result.data?.requestStaleNodesUpdate

      if (!jobId) {
        console.error(chalk.red('Error: Failed to create update job'))
        process.exit(1)
      }

      console.log(chalk.green(`\n✅ Update job created: ${jobId}`))
      console.log(
        chalk.gray(
          `\nThe workflow engine will process stale nodes in the background.`,
        ),
      )
      console.log(
        chalk.gray(`Use 'playtiss status ${handleId}' to check progress.`),
      )
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('submit-result')
  .description(
    'Submit player result for a workflow node (triggers stale detection for downstream nodes)',
  )
  .argument('<handle-id>', 'Execution Handle ID')
  .argument('<node-id>', 'Node ID in workflow')
  .argument('<output-data>', 'Output data as JSON string or file path')
  .option(
    '-c, --context <context-hash>',
    'Context asset hash (optional, uses default if omitted)',
  )
  .option('-m, --message <message>', 'Commit message describing the change')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (handleId: string, nodeId: string, outputData: string, options: { context?: string, message?: string, endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Parse output data (could be JSON string or file path)
      let output: unknown
      if (existsSync(outputData)) {
        // It's a file path
        output = decodeFromString(readFileSync(outputData, 'utf-8')) as DictAsset
        console.log(chalk.blue(`Loading output from file: ${outputData}`))
      }
      else {
        // It's a JSON string
        try {
          output = decodeFromString(outputData) as DictAsset
        }
        catch {
          console.error(
            chalk.red(
              'Error: Output data must be valid JSON or a path to a JSON file',
            ),
          )
          process.exit(1)
        }
      }

      // Store the output as an asset
      console.log(chalk.blue(`Storing output as asset...`))
      const outputAssetId = await store(output as DictAsset)
      console.log(chalk.gray(`Asset ID: ${outputAssetId}`))

      // Use default context if not provided (empty object hash)
      const contextAssetHash = await parseContextId(options.context)

      console.log(chalk.blue(`\nSubmitting player result for node: ${nodeId}`))
      if (options.message) {
        console.log(chalk.gray(`Message: ${options.message}`))
      }

      const result = await client.mutate({
        mutation: SUBMIT_PLAYER_INPUT,
        variables: {
          handleId: ensureTraceId(handleId),
          nodeId,
          contextAssetHash,
          outputAssetId,
          commitMessage: options.message || null,
        },
      })

      const jobId = result.data?.submitPlayerInput

      if (!jobId) {
        console.error(chalk.red('Error: Failed to submit player result'))
        process.exit(1)
      }

      console.log(chalk.green(`\n✅ Player result submitted successfully!`))
      console.log(chalk.green(`Job ID: ${jobId}`))
      console.log(
        chalk.yellow(
          `\n⚠️  Downstream nodes dependent on '${nodeId}' will be marked as STALE`,
        ),
      )
      console.log(
        chalk.gray(
          `\nUse 'playtiss status ${handleId}' to see updated node states.`,
        ),
      )
      console.log(
        chalk.gray(
          `Use 'playtiss update ${handleId}' to re-compute stale nodes.`,
        ),
      )
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('fail-task')
  .description('Mark a player task as failed')
  .argument('<handle-id>', 'Execution Handle ID')
  .argument('<node-id>', 'Node ID in workflow')
  .requiredOption('-r, --reason <reason>', 'Failure reason (required)')
  .option(
    '-c, --context <context-hash>',
    'Context asset hash (optional, uses default if omitted)',
  )
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (handleId: string, nodeId: string, options: { reason: string, context?: string, endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Use default context if not provided (empty object hash)
      const contextAssetHash = await parseContextId(options.context)

      console.log(chalk.blue(`\nMarking task as failed for node: ${nodeId}`))
      console.log(chalk.gray(`Reason: ${options.reason}`))

      const result = await client.mutate({
        mutation: FAIL_PLAYER_TASK,
        variables: {
          handleId: ensureTraceId(handleId),
          nodeId,
          contextAssetHash,
          reason: options.reason,
        },
      })

      const jobId = result.data?.failPlayerTask

      if (!jobId) {
        console.error(chalk.red('Error: Failed to mark task as failed'))
        process.exit(1)
      }

      console.log(chalk.green(`\n✅ Task marked as failed successfully!`))
      console.log(chalk.green(`Job ID: ${jobId}`))
      console.log(
        chalk.gray(
          `\nUse 'playtiss status ${handleId}' to see updated node state.`,
        ),
      )
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('rerun-task')
  .description('Request to rerun a specific workflow node')
  .argument('<handle-id>', 'Execution Handle ID')
  .argument('<node-id>', 'Node ID in workflow')
  .option('-m, --message <message>', 'Commit message describing the rerun')
  .option('-t, --tag <tag>', 'User tag for version tracking')
  .option(
    '-c, --context <context-hash>',
    'Context asset hash (optional, uses default if omitted)',
  )
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (handleId: string, nodeId: string, options: { message?: string, tag?: string, context?: string, endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Use default context if not provided (empty object hash)
      const contextAssetHash = await parseContextId(options.context)

      console.log(chalk.blue(`\nRequesting rerun for node: ${nodeId}`))
      if (options.message) {
        console.log(chalk.gray(`Message: ${options.message}`))
      }
      if (options.tag) {
        console.log(chalk.gray(`Tag: ${options.tag}`))
      }

      const result = await client.mutate({
        mutation: REQUEST_NODE_RERUN,
        variables: {
          handleId: ensureTraceId(handleId),
          nodeId,
          contextAssetHash,
          commitMessage: options.message || null,
          userTag: options.tag || null,
        },
      })

      const jobId = result.data?.requestNodeRerun

      if (!jobId) {
        console.error(chalk.red('Error: Failed to request node rerun'))
        process.exit(1)
      }

      console.log(chalk.green(`\n✅ Node rerun requested successfully!`))
      console.log(chalk.green(`Job ID: ${jobId}`))
      console.log(
        chalk.yellow(
          `\n⚠️  Downstream nodes dependent on '${nodeId}' will be marked as STALE`,
        ),
      )
      console.log(
        chalk.gray(
          `\nUse 'playtiss status ${handleId}' to check rerun progress.`,
        ),
      )
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

program
  .command('actions')
  .description('List available actions')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (options: { endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Fetch all actions using v3.1 pagination
      type ActionNode = ListActionsQuery['listActions']['edges'][number]['node']
      const allActions: ActionNode[] = []
      let cursor: string | undefined

      while (true) {
        const result = await client.query({
          query: LIST_ACTIONS,
          variables: { first: 50, after: cursor },
          fetchPolicy: 'network-only',
        })

        const connection = result.data?.listActions
        if (!connection?.edges) {
          break
        }
        for (const edge of connection.edges) {
          allActions.push(edge.node)
        }
        if (!connection.pageInfo.hasNextPage) {
          break
        }
        cursor = connection.pageInfo.endCursor ?? undefined
      }

      if (allActions.length === 0) {
        console.log(chalk.yellow('No actions found.'))
        return
      }

      console.log(chalk.blue(`\nAvailable Actions (${allActions.length}):`))
      console.log(
        chalk.gray('ID'.padEnd(40) + 'Name'.padEnd(30) + 'Description'),
      )
      console.log(chalk.gray('-'.repeat(80)))

      for (const action of allActions) {
        const id = action.id
        const name = (action.name || 'Untitled').slice(0, 28)
        const desc = (action.description || '').slice(0, 30)

        console.log(
          chalk.cyan(id.padEnd(40))
          + chalk.white(name.padEnd(30))
          + chalk.gray(desc),
        )
      }
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

// Command: actions describe <action-id>
program
  .command('actions-describe')
  .description('Show detailed information about a specific action')
  .argument('<action-id>', 'Action ID (TraceId or SystemActionId)')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (actionId: string, options: { endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      const result = await client.query({
        query: GET_ACTION_DETAILS,
        variables: { actionId: actionId as ActionId },
        fetchPolicy: 'network-only',
      })

      const action = result.data?.getActionDetails
      if (!action) {
        console.log(chalk.yellow(`Action not found: ${actionId}`))
        process.exit(1)
      }

      console.log(chalk.blue('\n=== Action Details ==='))
      console.log(chalk.gray('ID:          ') + chalk.cyan(action.id))
      console.log(
        chalk.gray('Name:        ') + chalk.white(action.name || 'Untitled'),
      )
      console.log(
        chalk.gray('Description: ')
        + chalk.white(action.description || 'No description'),
      )

      if (action.createdAt) {
        const date = new Date(action.createdAt)
        console.log(
          chalk.gray('Created:     ') + chalk.white(date.toLocaleString()),
        )
      }

      if (action.currentVersion) {
        console.log(
          chalk.gray('Version:     ') + chalk.cyan(action.currentVersion.id),
        )
        console.log(
          chalk.gray('Type:        ') + chalk.white(action.currentVersion.type),
        )
        const versionDate = new Date(action.currentVersion.timestamp_created)
        console.log(
          chalk.gray('Updated:     ')
          + chalk.white(versionDate.toLocaleString()),
        )
      }

      console.log('')
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

// Command: tasks list <action-id>
program
  .command('tasks-list')
  .description('List all computation instances (tasks) for a specific action')
  .argument('<action-id>', 'Action ID')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (actionId: string, options: { endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Fetch all tasks using v3.1 pagination
      type TaskNode = ListTasksByActionQuery['listTasksByAction']['edges'][number]['node']
      const allTasks: TaskNode[] = []
      let cursor: string | undefined

      while (true) {
        const result = await client.query({
          query: LIST_TASKS_BY_ACTION,
          variables: { actionId: actionId as ActionId, first: 50, after: cursor },
          fetchPolicy: 'network-only',
        })

        const connection = result.data?.listTasksByAction
        if (!connection?.edges) {
          break
        }
        for (const edge of connection.edges) {
          allTasks.push(edge.node)
        }
        if (!connection.pageInfo.hasNextPage) {
          break
        }
        cursor = connection.pageInfo.endCursor ?? undefined
      }

      if (allTasks.length === 0) {
        console.log(chalk.yellow(`No tasks found for action: ${actionId}`))
        return
      }

      console.log(
        chalk.blue(`\nTasks for Action ${actionId} (${allTasks.length}):`),
      )
      console.log(
        chalk.gray('Task ID'.padEnd(40) + 'Name'.padEnd(25) + 'Created'),
      )
      console.log(chalk.gray('-'.repeat(90)))

      for (const task of allTasks) {
        const id = task.id
        const name = (task.name || 'Untitled').slice(0, 23)
        const created = new Date(task.createdAt).toLocaleString()

        console.log(
          chalk.cyan(id.padEnd(40))
          + chalk.white(name.padEnd(25))
          + chalk.gray(created),
        )
      }
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

// Command: runs list <task-id>
program
  .command('runs-list')
  .description('List all historical workflow revisions for a specific task')
  .argument('<task-id>', 'Task ID (TraceId)')
  .option('-e, --endpoint <url>', 'GraphQL endpoint URL')
  .action(async (taskId: string, options: { endpoint?: string }) => {
    try {
      const client = createClient(options.endpoint)

      // Fetch all runs using v3.1 pagination
      type RunNode = ListRunsForTaskQuery['listRevisionsForTask']['edges'][number]['node']
      const allRuns: RunNode[] = []
      let cursor: string | undefined

      while (true) {
        const result = await client.query({
          query: LIST_RUNS_FOR_TASK,
          variables: { taskId: ensureTraceId(taskId), first: 50, after: cursor },
          fetchPolicy: 'network-only',
        })

        const connection = result.data?.listRevisionsForTask
        if (!connection?.edges) {
          break
        }
        for (const edge of connection.edges) {
          allRuns.push(edge.node)
        }
        if (!connection.pageInfo.hasNextPage) {
          break
        }
        cursor = connection.pageInfo.endCursor ?? undefined
      }

      if (allRuns.length === 0) {
        console.log(chalk.yellow(`No runs found for task: ${taskId}`))
        return
      }

      console.log(
        chalk.blue(
          `\nWorkflow Revisions for Task ${taskId} (${allRuns.length}):`,
        ),
      )
      console.log(
        chalk.gray('Run ID'.padEnd(40) + 'Status'.padEnd(15) + 'Created'),
      )
      console.log(chalk.gray('-'.repeat(80)))

      for (const run of allRuns) {
        const id = run.id
        const status = run.status || 'UNKNOWN'
        const created = new Date(run.createdAt).toLocaleString()

        console.log(
          chalk.cyan(id.padEnd(40))
          + chalk.white(status.padEnd(15))
          + chalk.gray(created),
        )
      }
    }
    catch (error) {
      console.error(chalk.red(`Error: ${(error as Error).message}`))
      process.exit(1)
    }
  })

// Handle unknown commands
program.on('command:*', function (operands) {
  console.error(chalk.red(`Unknown command: ${operands[0]}`))
  console.log(chalk.gray('See --help for available commands'))
  process.exit(1)
})

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp()
}

program.parse()
