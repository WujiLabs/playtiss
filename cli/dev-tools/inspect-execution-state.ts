#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: Inspect Task Execution State
 *
 * Inspects detailed task execution state information including
 * denormalized columns and expiration tracking.
 * Usage: tsx dev-tools/inspect-execution-state.ts <task-id>
 */

import dotenv from 'dotenv'

// Load environment configuration from local .env file
dotenv.config()

import Database from 'better-sqlite3'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'

// Helper function to get default DB path in ~/.playtiss
const getDefaultDbPath = () => {
  const playtissDir = path.join(homedir(), '.playtiss')
  // Ensure directory exists
  if (!fs.existsSync(playtissDir)) {
    fs.mkdirSync(playtissDir, { recursive: true })
  }
  return path.join(playtissDir, 'playtiss.db')
}

interface TaskExecutionStateRow {
  task_id: string
  runtime_status: string
  claim_timestamp: number | null
  claim_worker_id: string | null
  claim_ttl_seconds: number | null
  action_id: string | null
  expiration_time: number | null
}

interface TaskRow {
  task_id: string
  scope_id: string
  action_id: string
  inputs_content_hash: string | null
  name: string | null
  description: string | null
  current_version_id: string | null
  timestamp_created: number
}

function inspectTaskExecutionState(taskId: string): void {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath()
  console.log(`🔍 Using database: ${dbPath}`)

  const db = new Database(dbPath, { readonly: true })

  console.log(`⚡ Task Execution State Details`)
  console.log('━'.repeat(80))
  console.log(`Task ID: ${taskId}`)
  console.log()

  inspectFromDB(db, taskId)
}

function inspectFromDB(db: InstanceType<typeof Database>, taskId: string) {
  try {
    // Get task execution state
    const executionState = db.prepare('SELECT * FROM TaskExecutionStates WHERE task_id = ?').get(taskId) as TaskExecutionStateRow | undefined

    if (!executionState) {
      console.log('❌ No task execution state found for this task ID.')

      // Check if task exists in Tasks table
      const task = db.prepare('SELECT * FROM Tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined

      if (task) {
        console.log(
          '📋 Task exists in Tasks table but has no execution state.',
        )
        console.log(
          '   This might be a workflow definition task or other non-executable task.',
        )
        console.log()
        console.log('📋 Task Details:')
        console.log(`   Action ID: ${task.action_id}`)
        console.log(`   Name: ${task.name || '(unnamed)'}`)
        console.log(
          `   Description: ${task.description || '(no description)'}`,
        )
        console.log(
          `   Created: ${new Date(task.timestamp_created).toISOString()}`,
        )
      }
      else {
        console.log('❌ Task does not exist in Tasks table either.')
      }
      return
    }

    // Get related task info for comparison
    const task = db.prepare('SELECT * FROM Tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined

    console.log('⚡ Execution State:')
    console.log(`   Runtime Status: ${executionState.runtime_status}`)
    console.log(`   Action ID: ${executionState.action_id || '(null)'}`)

    if (executionState.claim_timestamp) {
      console.log(
        `   Claim Timestamp: ${new Date(executionState.claim_timestamp).toISOString()}`,
      )
      console.log(
        `   Claim Worker ID: ${executionState.claim_worker_id || '(null)'}`,
      )
      console.log(
        `   Claim TTL: ${executionState.claim_ttl_seconds || '(null)'} seconds`,
      )

      if (executionState.expiration_time) {
        const currentTime = Date.now()
        const expired = currentTime > executionState.expiration_time
        console.log(
          `   Expiration Time: ${new Date(executionState.expiration_time).toISOString()}`,
        )
        console.log(`   Claim Status: ${expired ? '❌ EXPIRED' : '✅ ACTIVE'}`)

        if (expired) {
          const expiredMs = currentTime - executionState.expiration_time
          console.log(
            `   Expired For: ${Math.round(expiredMs / 1000)} seconds`,
          )
        }
      }
    }
    else {
      console.log(`   Claim Timestamp: (not claimed)`)
    }

    console.log()

    if (task) {
      console.log('📋 Related Task Info:')
      console.log(`   Task ID: ${task.task_id}`)
      console.log(`   Action ID: ${task.action_id}`)
      console.log(`   Name: ${task.name || '(unnamed)'}`)
      console.log(`   Description: ${task.description || '(no description)'}`)
      console.log(
        `   Created: ${new Date(task.timestamp_created).toISOString()}`,
      )
      console.log(`   Current Version: ${task.current_version_id || '(none)'}`)
      console.log()

      // Check denormalization consistency
      if (executionState.action_id !== task.action_id) {
        console.log('⚠️  DENORMALIZATION INCONSISTENCY:')
        console.log(
          `   TaskExecutionStates.action_id: ${executionState.action_id}`,
        )
        console.log(`   Tasks.action_id: ${task.action_id}`)
        console.log()
      }
      else {
        console.log(
          '✅ Denormalized action_id is consistent with Tasks table.',
        )
        console.log()
      }
    }

    // Show runnable status
    console.log('🏃 Runnable Analysis:')
    const currentTime = Date.now()
    let isRunnable = false
    let reason = ''

    if (executionState.runtime_status === 'PENDING') {
      isRunnable = true
      reason = 'Status is PENDING'
    }
    else if (
      executionState.runtime_status === 'RUNNING'
      && executionState.expiration_time
      && currentTime > executionState.expiration_time
    ) {
      isRunnable = true
      reason = 'Status is RUNNING but claim has expired'
    }
    else if (executionState.runtime_status === 'RUNNING') {
      reason = 'Status is RUNNING with active claim'
    }
    else {
      reason = `Status is ${executionState.runtime_status} (not runnable)`
    }

    console.log(`   Is Runnable: ${isRunnable ? '✅ YES' : '❌ NO'}`)
    console.log(`   Reason: ${reason}`)
  }
  catch (error: any) {
    console.error(`❌ Error inspecting task execution state: ${error.message}`)
    throw error
  }
  finally {
    db.close()
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const taskId = process.argv[2]

  if (!taskId) {
    console.error('Usage: tsx dev-tools/inspect-execution-state.ts <task-id>')
    console.error('')
    console.error(
      'This tool inspects detailed task execution state information including:',
    )
    console.error('- Runtime status and claim information')
    console.error('- Denormalized action_id consistency')
    console.error('- Expiration time and claim status')
    console.error('- Runnable analysis based on current criteria')
    console.error('')
    console.error('Example:')
    console.error(
      '  tsx dev-tools/inspect-execution-state.ts 01977aaa-7b52-8f28-8a82-123456789abc',
    )
    process.exit(1)
  }

  try {
    inspectTaskExecutionState(taskId)
  }
  catch (error) {
    console.error('Failed to inspect task execution state:', error)
    process.exit(1)
  }
}
