// Copyright (c) 2026 Wuji Labs Inc
import { getEnv } from '../config.js'

export type StorageType = 'local' | 's3' | 'bridge'

// AWS credential types for web compatibility
export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string // For temporary credentials (STS)
}

export interface S3Config {
  bucket: string
  region: string
  credentials?: AwsCredentials // Optional - falls back to environment/profiles in Node.js
}

export interface BridgeConfig {
  baseUrl: string // e.g., "http://localhost:3000"
  apiPath?: string // defaults to "/api/assets"
}

export interface StorageConfig {
  readonly type: StorageType
  // Local storage config
  readonly localPath?: string
  // S3 storage config (for web environments)
  readonly s3?: S3Config
  // Bridge storage config (for UXP environments)
  readonly bridge?: BridgeConfig
}

// Environment variable names
const ENV_STORAGE_TYPE = 'PLAYTISS_STORAGE_TYPE'
const ENV_LOCAL_PATH = 'PLAYTISS_LOCAL_PATH'

// Helper to get default local path with dynamic Node.js imports for web compatibility
async function getDefaultLocalPath(): Promise<string> {
  try {
    // Try ESM dynamic import first
    const [{ homedir }, { default: path }] = await Promise.all([
      import('os'),
      import('path'),
    ])
    return path.join(homedir(), '.playtiss')
  }
  catch (importError: any) {
    // Fallback to require for CJS environments
    if (typeof require !== 'undefined') {
      const { homedir } = require('os')
      const path = require('path')
      return path.join(homedir(), '.playtiss')
    }
    else {
      throw new Error(
        'Node.js modules (os, path) not available in this environment. Please set PLAYTISS_LOCAL_PATH explicitly for local storage.',
      )
    }
  }
}

// Helper to get default storage type
function getDefaultStorageType(): StorageType {
  // Default to S3 for cloud-first architecture
  // Users can override with PLAYTISS_STORAGE_TYPE=local if needed
  return 's3'
}

// Cached default local path to avoid repeated async calls
let cachedDefaultLocalPath: string | null = null

// Lazy config object with getters
const config: StorageConfig = {
  get type(): StorageType {
    const storageType = getEnv(ENV_STORAGE_TYPE, getDefaultStorageType())
    if (storageType === 's3') return 's3'
    if (storageType === 'bridge') return 'bridge'
    return 'local'
  },
  get localPath(): string {
    // For synchronous access, we need to have already resolved the default path
    // This getter should only be used after calling getConfig() which resolves paths
    const envPath = getEnv(ENV_LOCAL_PATH, '')
    if (envPath) {
      return envPath
    }
    if (cachedDefaultLocalPath) {
      return cachedDefaultLocalPath
    }
    throw new Error(
      'Local path not available. Call getConfig() first to initialize, or set PLAYTISS_LOCAL_PATH environment variable.',
    )
  },
}

export async function getConfig(): Promise<StorageConfig> {
  // Initialize cached default local path if needed and not explicitly set
  if (!cachedDefaultLocalPath && !getEnv(ENV_LOCAL_PATH, '')) {
    try {
      cachedDefaultLocalPath = await getDefaultLocalPath()
    }
    catch (error) {
      // If we can't get default path and no env var is set, that's okay
      // The localPath getter will throw a more specific error when accessed
    }
  }
  return config
}
