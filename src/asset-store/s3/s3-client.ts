// Copyright (c) 2026 Wuji Labs Inc
import { S3Client } from '@aws-sdk/client-s3'

import { config } from '../../config.js'
import { type S3Config } from '../config.js'

// Shared S3 client management with override support
let client: S3Client | null = null
let overrideConfig: S3Config | null = null

/**
 * Override S3 configuration for web environments
 */
export function overrideS3Config(s3Config: S3Config): void {
  overrideConfig = s3Config
  // Reset client to force recreation with new config
  client = null
}

/**
 * Get S3 client with proper configuration fallback
 */
export function getS3Client(): S3Client {
  if (!client) {
    if (overrideConfig) {
      // Use explicit config (web environment)
      client = new S3Client({
        region: overrideConfig.region,
        credentials: overrideConfig.credentials,
        maxAttempts: 3,
      })
    }
    else {
      // Use environment config (Node.js)
      // Set maxSockets to 150 to handle high S3 concurrency (store: 40, load: 80)
      // Set requestTimeout to 60s to handle large file uploads (e.g., 17MB images)
      client = new S3Client({
        region: config.aws.region,
        credentials: config.aws.credentials,
        maxAttempts: 3,
        requestHandler: {
          requestTimeout: 60000,
          httpsAgent: {
            maxSockets: 150,
          },
        },
      })
    }
  }
  return client
}

/**
 * Get S3 bucket with proper configuration fallback
 */
export function getS3Bucket(): string {
  return overrideConfig?.bucket || config.s3.bucket
}

/**
 * Get S3 region with proper configuration fallback
 */
export function getS3Region(): string {
  return overrideConfig?.region || config.aws.region
}

/**
 * Get S3 object parameters with proper bucket fallback
 */
export function getS3ObjectParams(objectKey: string): {
  Bucket: string
  Key: string
} {
  return { Bucket: getS3Bucket(), Key: objectKey }
}
