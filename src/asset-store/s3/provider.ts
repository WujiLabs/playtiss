// Copyright (c) 2026 Wuji Labs Inc
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { type StreamingBlobPayloadInputTypes } from '@smithy/types'
import { CID } from 'multiformats/cid'

import { config as awsConfig } from '../../config.js'
import { type AssetId } from '../../index.js'
import { type StorageConfig } from '../config.js'
import {
  type AssetReferences,
  type StorageProvider,
} from '../storage-provider.js'
import {
  saveAssetReferences as saveS3AssetReferences,
  saveAssetToActionReferences as saveS3AssetToActionReferences,
  saveAssetToVersionReferences as saveS3AssetToVersionReferences,
  saveAssetWithMetadata,
} from './metadata.js'
import {
  getS3Client,
  getS3ObjectParams,
  getS3Region,
  overrideS3Config,
} from './s3-client.js'

/**
 * AWS S3 storage provider for Playtiss assets.
 *
 * Objects are stored under the `objects/{cid}` key prefix as opaque blobs.
 * Cross-asset reference metadata lives in a parallel `references/` namespace
 * managed by the metadata module.
 */
export class S3StorageProvider implements StorageProvider {
  private initialized = false

  constructor(private readonly config: StorageConfig) {
    this.validateAndInit()
  }

  // ---------------------------------------------------------------------------
  // StorageProvider interface
  // ---------------------------------------------------------------------------

  async hasBuffer(id: AssetId): Promise<boolean> {
    this.ensureReady()
    const params = this.objectParams(id)
    try {
      await getS3Client().send(new HeadObjectCommand(params))
      return true
    }
    catch (err) {
      return this.handleExistenceError(err, id, params)
    }
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    this.ensureReady()
    const params = this.objectParams(id)
    try {
      if (!(await this.hasBuffer(id))) {
        throw new Error(
          `Asset ${id} not found in S3 bucket '${params.Bucket}' at key '${params.Key}'`,
        )
      }
      const response = await getS3Client().send(new GetObjectCommand(params))
      if (!response.Body) {
        throw new Error(`Asset ${id} exists but has no body content`)
      }
      return await response.Body.transformToByteArray()
    }
    catch (err) {
      throw this.enrichFetchError(err, id, params)
    }
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    this.ensureReady()
    try {
      await saveAssetWithMetadata(buffer, id)

      if (references) {
        await this.persistReferences(id, references)
      }

      console.debug(
        `S3StorageProvider saved asset ${id} (${buffer.length} bytes)`,
      )
    }
    catch (err) {
      console.error(`S3StorageProvider.saveBuffer failed for ${id}:`, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Extended S3 operations (not part of generic StorageProvider)
  // ---------------------------------------------------------------------------

  /**
   * Upload a readable stream (e.g. from a file handle) with a SHA-256
   * integrity check derived from the CID multihash.
   */
  async saveStream(
    stream: StreamingBlobPayloadInputTypes,
    fileSize: number,
    id: AssetId,
  ): Promise<void> {
    this.ensureReady()
    const sha256 = Buffer.from(CID.parse(id).multihash.digest).toString('base64')
    const command = new PutObjectCommand({
      Body: stream,
      ContentLength: fileSize,
      ChecksumSHA256: sha256,
      ...this.objectParams(id),
    })
    await getS3Client().send(command)
  }

  /**
   * Generate a pre-signed download URL for an asset, valid for
   * `expiresIn` seconds (default 1 hour).
   */
  async getDownloadUrl(
    id: AssetId,
    filename?: string,
    expiresIn = 3600,
  ): Promise<string> {
    this.ensureReady()
    const displayName = filename ?? `${id.slice(0, 8)}.bin`
    const command = new GetObjectCommand({
      ...this.objectParams(id),
      ResponseContentDisposition: `attachment;filename=${displayName}`,
    })
    return getSignedUrl(getS3Client(), command, { expiresIn })
  }

  // ---------------------------------------------------------------------------
  // Initialisation & validation
  // ---------------------------------------------------------------------------

  private validateAndInit(): void {
    const issues: string[] = []

    if (this.config.s3) {
      if (!this.config.s3.bucket) issues.push('S3 bucket is required in explicit configuration')
      if (!this.config.s3.region) issues.push('S3 region is required in explicit configuration')
      const isNode = typeof process !== 'undefined' && process.versions?.node
      if (!isNode && !this.config.s3.credentials) {
        issues.push('S3 credentials are required for web environments')
      }
      if (issues.length === 0) {
        overrideS3Config(this.config.s3)
        console.info(
          `S3StorageProvider initialized: bucket=${this.config.s3.bucket}, region=${this.config.s3.region}`,
        )
      }
    }
    else {
      if (!awsConfig.s3.bucket) issues.push('S3_BUCKET environment variable is not set')
      if (!awsConfig.aws.region) issues.push('AWS_REGION environment variable is not set')
      if (issues.length === 0) {
        console.info(
          `S3StorageProvider initialized: bucket=${awsConfig.s3.bucket}, region=${awsConfig.aws.region}`,
        )
      }
    }

    if (issues.length > 0) {
      const msg = `AWS S3 configuration incomplete:\n${issues.map(i => `  - ${i}`).join('\n')}\n\nFor web: use setS3WebStorageProvider(). For Node.js: set environment variables.`
      console.error('S3StorageProvider init failed:', msg)
      throw new Error(msg)
    }

    this.initialized = true
  }

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('S3StorageProvider not properly initialized. Check AWS configuration.')
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Map an asset CID to its S3 object key. */
  private objectParams(id: AssetId): { Bucket: string, Key: string } {
    return getS3ObjectParams(`objects/${id}`)
  }

  /** Persist the three reference flavours in parallel when present. */
  private async persistReferences(
    id: AssetId,
    refs: AssetReferences,
  ): Promise<void> {
    const tasks: Promise<void>[] = []

    if (refs.assetReferences?.length) {
      tasks.push(saveS3AssetReferences(id, refs.assetReferences))
    }
    if (refs.actionReferences?.length) {
      tasks.push(saveS3AssetToActionReferences(id, refs.actionReferences))
    }
    if (refs.versionReferences?.length) {
      tasks.push(saveS3AssetToVersionReferences(id, refs.versionReferences))
    }

    if (tasks.length) {
      await Promise.all(tasks)
      console.debug(`S3StorageProvider persisted ${tasks.length} reference set(s) for ${id}`)
    }
  }

  /**
   * Interpret S3 HEAD errors — 404s and 403s (when ListBucket is
   * missing AWS returns 403 instead of 404) are treated as "not found".
   */
  private handleExistenceError(
    err: any,
    id: AssetId,
    params: { Bucket: string, Key: string },
  ): false {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false
    }
    if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) {
      console.debug(`S3 403 for ${id} — treating as not found (missing ListBucket permission)`)
      return false
    }

    console.warn(`S3 hasBuffer failed for ${id}:`, {
      error: err.name ?? 'Unknown',
      message: err.message,
      statusCode: err.$metadata?.httpStatusCode,
      bucket: params.Bucket,
      region: getS3Region(),
    })

    if (err.name === 'CredentialsProviderError') {
      console.error(`S3 credentials issue for ${id}. Check AWS configuration.`)
    }

    return false
  }

  /**
   * Wrap a raw S3 fetch error with actionable context so the caller
   * gets a single, descriptive message instead of an opaque SDK error.
   */
  private enrichFetchError(
    err: any,
    id: AssetId,
    params: { Bucket: string, Key: string },
  ): Error {
    // Already a user-friendly error — pass through.
    if (err.message?.includes('not found in S3 bucket')) return err

    const region = getS3Region()

    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return new Error(`Asset ${id} not found in S3 (bucket: ${params.Bucket}, key: ${params.Key})`)
    }
    if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) {
      return new Error(`Access denied for asset ${id}. Check S3 bucket permissions and AWS credentials.`)
    }
    if (err.name === 'CredentialsProviderError') {
      return new Error(`AWS credentials not available. Check AWS_PROFILE, AWS_REGION, and credential configuration.`)
    }
    if (err.name === 'NetworkingError' || err.code === 'ENOTFOUND') {
      return new Error(`Network error accessing S3 for ${id}. Check connection and region (${region}).`)
    }

    return new Error(
      `Failed to fetch asset ${id} from S3: ${err.message} (bucket: ${params.Bucket}, region: ${region})`,
    )
  }
}
