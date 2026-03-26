// Copyright (c) 2026 Wuji Labs Inc
// Environment detection
const isNode
  = typeof process !== 'undefined'
    && process.versions != null
    && process.versions.node != null

// Lazy credential provider that loads AWS SDK when needed
let awsCredentialProvider: any = null
let dotenvLoaded = false

/**
 * Find and load .env configuration file with upward directory search.
 * Search strategy:
 * 1. Search upward from working directory
 * 2. Environment variables only (fallback)
 *
 * @returns Path to loaded .env file, or null if no file loaded
 */
async function findAndLoadEnv(): Promise<string | null> {
  if (!isNode) return null

  try {
    // Use dynamic import for ES modules compatibility
    const path = await import('path')
    const fs = await import('fs')

    // Search upward from working directory
    let current = process.cwd()

    while (true) {
      const envFile = path.join(current, '.env')
      if (fs.existsSync(envFile)) {
        console.log(`Loading config from: ${envFile}`)
        return envFile
      }

      // Stop at filesystem root
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    // No .env file found - silent fallback to environment variables
    return null
  }
  catch {
    // Error in path resolution - fallback to environment variables
    return null
  }
}

// Helper to ensure dotenv is loaded with discovery
async function ensureDotenvLoaded() {
  if (!dotenvLoaded && isNode) {
    try {
      const dotenv = await import('dotenv')
      const envPath = await findAndLoadEnv()

      if (envPath) {
        dotenv.config({ path: envPath })
      }
      else {
        // Fallback to default behavior (looks in current directory)
        dotenv.config()
      }

      dotenvLoaded = true
    }
    catch {
      // Ignore if dotenv is not available
    }
  }
}

// Helper to get credentials lazily
async function getAwsCredentialProvider() {
  if (!awsCredentialProvider && isNode) {
    await ensureDotenvLoaded()
    try {
      const awsProviders = await import('@aws-sdk/credential-providers')
      const profile = getEnv('AWS_PROFILE', 'default')
      // Chain credentials: environment variables first, then profile-based
      awsCredentialProvider = awsProviders.createCredentialChain(
        awsProviders.fromEnv(),
        awsProviders.fromIni({ profile }),
      )
    }
    catch (e) {
      console.warn('Failed to load AWS credential provider:', e)
      awsCredentialProvider = async () => ({
        accessKeyId: '',
        secretAccessKey: '',
      })
    }
  }
  return awsCredentialProvider
}

// Helper to safely get env var
export const getEnv = (key: string, defaultValue: string = ''): string => {
  if (!isNode) return defaultValue
  try {
    // Ensure dotenv is loaded on first access (sync fallback)
    if (!dotenvLoaded) {
      // Try to load synchronously if possible, with CJS/ESM compatibility
      try {
        // Try require first (works in CJS environments)
        if (typeof require !== 'undefined') {
          const dotenv = require('dotenv')
          dotenv.config()
        }
        // Note: Can't use await import() here because this is a sync function
        // The async version in ensureDotenvLoaded() will handle ESM properly
        dotenvLoaded = true
      }
      catch {
        // Ignore if dotenv loading fails - environment variables may still be available
      }
    }
    return process.env[key] || defaultValue
  }
  catch {
    return defaultValue
  }
}

// Type for AWS credentials
type AwsCredentialIdentityProvider = () => Promise<{
  accessKeyId: string
  secretAccessKey: string
}>

// No-op credential provider for browser environment
const noopCredentials: AwsCredentialIdentityProvider = async () => ({
  accessKeyId: '',
  secretAccessKey: '',
})

// Get credentials based on environment
function getCredentials(): AwsCredentialIdentityProvider {
  if (!isNode) {
    return noopCredentials
  }

  // Return a function that lazily loads the credential provider
  return async () => {
    const provider = await getAwsCredentialProvider()
    return await provider()
  }
}

interface AWSConfig {
  readonly region: string
  credentials: AwsCredentialIdentityProvider
}

export const config = {
  aws: {
    get region() {
      return getEnv('AWS_REGION', 'us-west-1')
    },
    credentials: getCredentials(),
  } as AWSConfig,
  s3: {
    get bucket() {
      return getEnv('S3_BUCKET', 'playtiss-infrastructure-dev-assets')
    },
  },
} as const

// Type for the config object
export type Config = typeof config

// Helper function to get a specific config value
export function getConfig<K extends keyof Config>(key: K): Config[K] {
  return config[key]
}

// Helper function to get a nested config value
export function getNestedConfig<
  K extends keyof Config,
  N extends keyof Config[K],
>(key: K, nestedKey: N): Config[K][N] {
  return config[key][nestedKey]
}
