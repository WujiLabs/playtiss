#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc
/**
 * Sample Add Two Processor for TypeScript Worker
 *
 * This processor adds two integer inputs together, matching the functionality
 * of the Python playtiss-action-runner sample_add_two.py implementation.
 */

// Auto-load configuration before importing other modules
import './config.js'

import type { ActionId, DictAsset } from 'playtiss'
import { runWorker } from './index.js'
import type { RunnerContext } from './runner.js'

// add_two action ID - consistent with integration test seed DB
export const ACTION_ID_ADD_TWO = '019d048e-d520-8ddb-8b9b-3b04d2000001'

class ErrorWithOutput extends Error {
  output?: DictAsset
  constructor(message: string, output?: DictAsset) {
    super(message)
    this.output = output
  }
}

/**
 * Add two integer inputs together
 */
export async function addTwo(asset: DictAsset, context: RunnerContext): Promise<DictAsset> {
  console.info(`Processing add_two task ${context.taskId}`)

  if (!('A' in asset)) {
    const error = new ErrorWithOutput('`A` key not found')
    error.output = { error: 'Missing A input key' }
    throw error
  }
  if (!('B' in asset)) {
    const error = new ErrorWithOutput('`B` key not found')
    error.output = { error: 'Missing B input key' }
    throw error
  }

  const a = asset.A
  const b = asset.B

  if (typeof a === 'boolean' || typeof a !== 'number' || !Number.isInteger(a)) {
    const error = new ErrorWithOutput('A type not int')
    error.output = { error: `Expected int for A, got ${typeof a}` }
    throw error
  }
  if (typeof b === 'boolean' || typeof b !== 'number' || !Number.isInteger(b)) {
    const error = new ErrorWithOutput('B type not int')
    error.output = { error: `Expected int for B, got ${typeof b}` }
    throw error
  }

  const result: DictAsset = { output: a + b }
  console.info(`Add_two result: ${a} + ${b} = ${result.output}`)
  return result
}

/**
 * Main CLI function for running the add_two worker
 */
async function main() {
  console.log('🚀 Starting TypeScript Add Two Worker...')
  console.log(`📋 Action ID: ${ACTION_ID_ADD_TWO}`)
  console.log('🔢 Ready to process add_two tasks')

  await runWorker(ACTION_ID_ADD_TWO as ActionId, addTwo, {
    workerId: 'ts-add-two-worker',
    concurrency: 3,
    pollInterval: 2000, // 2 seconds
    batchSize: 10,
  })
}

// Handle graceful shutdown
const shutdown = () => {
  console.log('\n⏹️  Shutdown signal received, stopping worker...')
  process.exit(0)
}

// Run if this file is executed directly
// Skip this check when built as CJS (import.meta is empty/undefined in CJS)
if (import.meta && import.meta.url === `file://${process.argv[1]}`) {
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Run the worker
  main().catch((error) => {
    console.error('❌ Add Two Worker failed:', error)
    process.exit(1)
  })
}
