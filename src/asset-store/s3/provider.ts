// Copyright (c) 2026 Wuji Labs Inc
import { config as awsConfig } from '../../config.js'
import { type AssetId } from '../../index.js'
import { type StorageConfig } from '../config.js'
import {
  type AssetReferences,
  type StorageProvider,
} from '../storage-provider.js'
import {
  saveAssetWithMetadata,
  saveAssetReferences as saveS3AssetReferences,
  saveAssetToActionReferences as saveS3AssetToActionReferences,
  saveAssetToVersionReferences as saveS3AssetToVersionReferences,
} from './metadata.js'
import { overrideS3Config } from './s3-client.js'
import { fetch_buffer, has_buffer } from './store.js'

export class S3StorageProvider implements StorageProvider {
  private initialized = false

  constructor(private readonly config: StorageConfig) {
    this.validateConfiguration()
  }

  private validateConfiguration() {
    const issues: string[] = []

    // Check if we have explicit S3 config (web environment)
    if (this.config.s3) {
      // Web environment - validate explicit config and set override
      if (!this.config.s3.bucket) {
        issues.push('S3 bucket is required in explicit configuration')
      }
      if (!this.config.s3.region) {
        issues.push('S3 region is required in explicit configuration')
      }
      const isNode = typeof process !== 'undefined' && process.versions?.node
      if (!isNode && !this.config.s3.credentials) {
        issues.push('S3 credentials are required for web environments')
      }

      if (issues.length === 0) {
        // Override the S3 client to use explicit config
        overrideS3Config(this.config.s3)
        console.info(
          `S3StorageProvider initialized with explicit config: bucket=${this.config.s3.bucket}, region=${this.config.s3.region}`,
        )
      }
    }
    else {
      // Node.js environment - validate environment variables (no override needed)
      if (!awsConfig.s3.bucket) {
        issues.push('S3_BUCKET environment variable is not set')
      }
      if (!awsConfig.aws.region) {
        issues.push('AWS_REGION environment variable is not set')
      }

      if (issues.length === 0) {
        console.info(
          `S3StorageProvider initialized with environment config: bucket=${awsConfig.s3.bucket}, region=${awsConfig.aws.region}`,
        )
      }
    }

    if (issues.length > 0) {
      const errorMessage = `AWS S3 configuration is incomplete:\n${issues.map(issue => `  - ${issue}`).join('\n')}\n\nFor web environments, use setS3WebStorageProvider(). For Node.js, set environment variables.`
      console.error('S3StorageProvider initialization failed:', errorMessage)
      throw new Error(errorMessage)
    }

    this.initialized = true
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        'S3StorageProvider is not properly initialized. Check AWS configuration.',
      )
    }
  }

  async hasBuffer(id: AssetId): Promise<boolean> {
    this.ensureInitialized()
    try {
      return await has_buffer(id)
    }
    catch (error: any) {
      console.error(
        `S3StorageProvider.hasBuffer failed for asset ${id}:`,
        error.message,
      )
      throw error
    }
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    this.ensureInitialized()
    try {
      return await fetch_buffer(id)
    }
    catch (error: any) {
      console.error(
        `S3StorageProvider.fetchBuffer failed for asset ${id}:`,
        error.message,
      )
      throw error
    }
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    this.ensureInitialized()
    try {
      // Use S3 metadata storage instead of database
      await saveAssetWithMetadata(buffer, id)

      // Save references if provided
      if (references) {
        if (
          references.assetReferences
          && references.assetReferences.length > 0
        ) {
          await saveS3AssetReferences(id, references.assetReferences)
          console.debug(
            `Saved ${references.assetReferences.length} asset references for ${id}`,
          )
        }
        if (
          references.actionReferences
          && references.actionReferences.length > 0
        ) {
          await saveS3AssetToActionReferences(id, references.actionReferences)
          console.debug(
            `Saved ${references.actionReferences.length} action references for ${id}`,
          )
        }
        if (
          references.versionReferences
          && references.versionReferences.length > 0
        ) {
          await saveS3AssetToVersionReferences(
            id,
            references.versionReferences,
          )
          console.debug(
            `Saved ${references.versionReferences.length} version references for ${id}`,
          )
        }
      }

      console.debug(
        `S3StorageProvider successfully saved asset ${id} (${buffer.length} bytes)`,
      )
    }
    catch (error: any) {
      console.error(
        `S3StorageProvider.saveBuffer failed for asset ${id}:`,
        error.message,
      )
      throw error
    }
  }
}
