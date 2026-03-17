// Copyright (c) 2026 Wuji Labs Inc
/**
 * Configuration for TypeScript Worker
 *
 * This module handles environment variable loading and validation
 * for the TypeScript worker package, including support for custom .env file paths.
 */

import { config } from 'dotenv'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'

export interface WorkerConfig {
  actionId?: string
  workerId?: string
  graphqlUrl: string
  authToken?: string
  concurrency: number
  pollInterval: number
  batchSize: number
  timeoutInterval?: number
}

/**
 * Find and load environment configuration with fallback strategy.
 *
 * @param configPath Optional explicit path to .env file
 * @returns Path to loaded .env file, or null if no file loaded
 */
export function findAndLoadEnv(configPath?: string): string | null {
  // Option 1: Explicit config path
  if (configPath && existsSync(configPath)) {
    console.log(`Loading config from: ${configPath}`)
    config({ path: configPath })
    return configPath
  }

  // Option 2: Search upward from working directory
  let current = process.cwd()
  while (true) {
    const envFile = resolve(current, '.env')
    if (existsSync(envFile)) {
      console.log(`Loading config from: ${envFile}`)
      config({ path: envFile })
      return envFile
    }

    const parent = dirname(current)
    if (parent === current) break // Reached filesystem root
    current = parent
  }

  // Option 3: Environment variables only (silent fallback)
  return null
}

/**
 * Load environment configuration with CLI --config support.
 *
 * Parses --config argument without interfering with other arguments.
 *
 * @returns Path to loaded .env file, or null if no file loaded
 */
export function loadEnvWithCliSupport(): string | null {
  // Simple argument parsing for --config
  const args = process.argv
  const configIndex = args.findIndex(arg => arg === '--config')
  const configPath = configIndex !== -1 && configIndex + 1 < args.length
    ? args[configIndex + 1]
    : undefined

  return findAndLoadEnv(configPath)
}

// Auto-load configuration on module import
let configLoaded = false

/**
 * Ensure configuration is loaded exactly once.
 */
export function ensureConfigLoaded(): void {
  if (!configLoaded) {
    loadEnvWithCliSupport()
    configLoaded = true
  }
}

// Auto-load configuration when this module is imported
ensureConfigLoaded()

/**
 * Get worker configuration from environment variables
 */
export function getWorkerConfig(): WorkerConfig {
  // Ensure environment is loaded
  ensureConfigLoaded()

  return {
    actionId: process.env.ACTION_ID,
    workerId: process.env.WORKER_ID,
    graphqlUrl: process.env.PLAYTISS_GRAPHQL_URL || 'http://localhost:4000/graphql',
    authToken: process.env.AUTH_TOKEN,
    concurrency: parseInt(process.env.CONCURRENCY || '1'),
    pollInterval: parseInt(process.env.POLL_INTERVAL || '5000'),
    batchSize: parseInt(process.env.BATCH_SIZE || '10'),
    timeoutInterval: process.env.TIMEOUT_INTERVAL ? parseInt(process.env.TIMEOUT_INTERVAL) : undefined,
  }
}

/**
 * Validate worker configuration
 */
export function validateConfig(config: WorkerConfig): { valid: boolean, errors: string[] } {
  const errors: string[] = []

  if (!config.graphqlUrl) {
    errors.push('PLAYTISS_GRAPHQL_URL is required')
  }

  if (config.concurrency < 0) {
    errors.push('CONCURRENCY must be >= 0')
  }

  if (config.pollInterval < 1000) {
    errors.push('POLL_INTERVAL must be >= 1000ms')
  }

  if (config.batchSize < 1) {
    errors.push('BATCH_SIZE must be >= 1')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
