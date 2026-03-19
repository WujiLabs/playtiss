// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
/**
 * Workflow Discovery Service - v12 Handle-Based API
 *
 * Implements dedicated workflow engine architecture:
 * - Discovers workflow tasks using v12 API
 * - Creates concurrent orchestrators for each workflow
 * - Maintains long-lived subscriptions to subtask states
 * - Reacts to events to dispatch dependent subtasks
 */

// Load environment variables before any other imports
import * as dotenv from 'dotenv'
dotenv.config()

import { homedir } from 'os'
import path from 'path'
import { type UserActionId } from 'playtiss/types/playtiss'
import { WorkflowEngine } from './engine/workflow-engine.js'

// Configuration
const POLL_INTERVAL = 10 * 1000 // 10 seconds

type PipelineId = UserActionId

// Hardcoded pipeline list (workflow action IDs)
const MONITORED_PIPELINES: PipelineId[] = [
  // "0197a952-d7c6-8fe4-87a8-56aeb0000001" as PipelineId, // Add Three Integer (old)
  // "0197cd70-9951-8971-8fd5-04b75b000001" as PipelineId, // Add Three Numbers (previous)
  '019d048e-d525-89ca-8fed-1f12e6000001' as PipelineId, // Add Three Numbers (IPLD test)
]

// Main entry point
async function main() {
  console.log('🚀 Starting Pipeline Runner - Workflow Engine v12')

  // Enable concurrency monitoring
  const { enablePeriodicLogging, logLimiterStats } = await import(
    './utils/concurrency-limiter.js',
  )
  enablePeriodicLogging()
  console.log('🚦 Concurrency limiting enabled with monitoring')

  // Log initial configuration
  console.log('🔧 Configuration:')
  console.log('  - GraphQL Socket Pool: 200 connections')
  console.log('  - BatchHttpLink: batchMax=15, batchInterval=20ms')
  console.log(
    '  - GraphQL Limits: workflow-orchestration=50, task-polling/creation/update=40',
  )
  console.log(
    '  - S3 Limits: s3-store=40, s3-load=80 (separate socket pool: 150)',
  )

  // Initial limiter stats
  logLimiterStats()

  // Create and start workflow engine
  const engine = new WorkflowEngine({
    monitoredPipelines: MONITORED_PIPELINES,
    pollInterval: POLL_INTERVAL,
    graphqlUrl:
      process.env.PLAYTISS_GRAPHQL_ENDPOINT || 'http://localhost:4000/graphql',
    mergeDbPath:
      process.env.PIPELINE_MERGE_DB_PATH
      || path.join(
        process.env.HOME || homedir(),
        '.playtiss',
        'pipeline-merge-accumulator.db',
      ),
  })

  // Start the engine
  await engine.start()

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n📛 Received ${signal}, shutting down gracefully...`)
    await engine.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log(
    `✅ Workflow Engine started, monitoring ${MONITORED_PIPELINES.length} pipelines`,
  )
  console.log(`📊 Poll interval: ${POLL_INTERVAL / 1000}s`)
}

// Start the workflow engine
main().catch((error) => {
  console.error('Fatal error starting workflow engine:', error)
  process.exit(1)
})
