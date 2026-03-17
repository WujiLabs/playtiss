// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { type StreamingBlobPayloadInputTypes } from '@smithy/types'
import { type AssetId } from '../../index.js'
import {
  getS3Client,
  getS3ObjectParams,
  getS3Region,
  overrideS3Config as setOverrideConfig,
} from './s3-client.js'

// Re-export for backward compatibility
export const overrideS3Config = setOverrideConfig

function get_params(id: AssetId): { Bucket: string, Key: string } {
  const s3_key = `objects/${id}` // loose objects, no packing
  return getS3ObjectParams(s3_key)
}

export async function has_buffer(id: AssetId): Promise<boolean> {
  const params = get_params(id)

  const command = new HeadObjectCommand(params)
  try {
    await getS3Client().send(command)
    return true
  }
  catch (error: any) {
    // Don't log 404s as errors since they're expected when checking existence
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false
    }

    // Handle 403 errors gracefully - without ListBucket permission, AWS returns 403 instead of 404
    // Assume object doesn't exist to avoid unnecessary uploads (putObject will handle real permission issues)
    if (
      error.name === 'AccessDenied'
      || error.$metadata?.httpStatusCode === 403
    ) {
      console.debug(
        `S3 403 error for asset ${id} - treating as not found due to missing ListBucket permission`,
      )
      return false
    }

    // Log other errors for debugging
    console.warn(`S3 hasBuffer failed for asset ${id}:`, {
      error: error.name || 'Unknown',
      message: error.message,
      statusCode: error.$metadata?.httpStatusCode,
      bucket: params.Bucket,
      region: getS3Region(),
    })

    // For credential/permission issues, return false but log the issue
    if (error.name === 'CredentialsProviderError') {
      console.error(
        `S3 credentials issue for asset ${id}. Check AWS configuration.`,
      )
    }

    return false
  }
}

export async function fetch_buffer(id: AssetId): Promise<Uint8Array> {
  const params = get_params(id)

  try {
    // First check if asset exists for better error messages
    if (!(await has_buffer(id))) {
      throw new Error(
        `Asset ${id} not found in S3 bucket '${params.Bucket}' at key '${params.Key}'`,
      )
    }

    const command = new GetObjectCommand(params)
    const response = await getS3Client().send(command)

    if (!response.Body) {
      throw new Error(`Asset ${id} exists but has no body content`)
    }

    return await response.Body.transformToByteArray()
  }
  catch (error: any) {
    // If it's already our custom error, re-throw it
    if (error.message.includes('not found in S3 bucket')) {
      throw error
    }

    // Enhanced error information for debugging
    const errorInfo = {
      assetId: id,
      bucket: params.Bucket,
      key: params.Key,
      region: getS3Region(),
      errorName: error.name || 'Unknown',
      errorMessage: error.message,
      statusCode: error.$metadata?.httpStatusCode,
    }

    console.error('S3 fetchBuffer failed:', errorInfo)

    // Specific error handling for common issues
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      throw new Error(
        `Asset ${id} not found in S3 storage (bucket: ${params.Bucket}, key: ${params.Key})`,
      )
    }

    if (
      error.name === 'AccessDenied'
      || error.$metadata?.httpStatusCode === 403
    ) {
      throw new Error(
        `Access denied for asset ${id}. Check S3 bucket permissions and AWS credentials.`,
      )
    }

    if (error.name === 'CredentialsProviderError') {
      throw new Error(
        `AWS credentials not available. Check AWS_PROFILE, AWS_REGION, and credential configuration.`,
      )
    }

    if (error.name === 'NetworkingError' || error.code === 'ENOTFOUND') {
      throw new Error(
        `Network error accessing S3 for asset ${id}. Check internet connection and AWS region (${errorInfo.region}).`,
      )
    }

    // Generic error with enhanced context
    throw new Error(
      `Failed to fetch asset ${id} from S3: ${error.message} (bucket: ${params.Bucket}, region: ${errorInfo.region})`,
    )
  }
}

export async function save_buffer(buffer: Uint8Array, id: AssetId) {
  const params = get_params(id)

  try {
    const command = new PutObjectCommand({
      Body: new Uint8Array(buffer),
      ...params,
    })

    const response = await getS3Client().send(command)

    // Log successful saves for audit trail
    console.debug(
      `Asset ${id} saved to S3: ${params.Bucket}/${params.Key} (${buffer.length} bytes)`,
    )

    return response
  }
  catch (error: any) {
    // Enhanced error information for debugging
    const errorInfo = {
      assetId: id,
      bucket: params.Bucket,
      key: params.Key,
      region: getS3Region(),
      bufferSize: buffer.length,
      errorName: error.name || 'Unknown',
      errorMessage: error.message,
      statusCode: error.$metadata?.httpStatusCode,
    }

    console.error('S3 saveBuffer failed:', errorInfo)

    // Specific error handling for common save issues
    if (
      error.name === 'AccessDenied'
      || error.$metadata?.httpStatusCode === 403
    ) {
      throw new Error(
        `Access denied saving asset ${id} to S3. Check S3 bucket write permissions and AWS credentials.`,
      )
    }

    if (error.name === 'CredentialsProviderError') {
      throw new Error(
        `AWS credentials not available for saving asset ${id}. Check AWS_PROFILE, AWS_REGION, and credential configuration.`,
      )
    }

    if (error.name === 'NetworkingError' || error.code === 'ENOTFOUND') {
      throw new Error(
        `Network error saving asset ${id} to S3. Check internet connection and AWS region (${errorInfo.region}).`,
      )
    }

    if (error.name === 'NoSuchBucket') {
      throw new Error(
        `S3 bucket '${params.Bucket}' does not exist. Check S3_BUCKET environment variable.`,
      )
    }

    if (error.name === 'InvalidBucketName') {
      throw new Error(
        `Invalid S3 bucket name '${params.Bucket}'. Check S3_BUCKET environment variable format.`,
      )
    }

    if (error.$metadata?.httpStatusCode === 507) {
      throw new Error(
        `S3 storage full for asset ${id}. Contact AWS support or check bucket quota.`,
      )
    }

    // Generic error with enhanced context
    throw new Error(
      `Failed to save asset ${id} to S3: ${error.message} (bucket: ${params.Bucket}, region: ${errorInfo.region}, size: ${buffer.length} bytes)`,
    )
  }
}

export async function save_stream(
  stream: StreamingBlobPayloadInputTypes,
  fileSize: number,
  id: AssetId,
) {
  // Both Node.JS and browser:
  // const sha256 = btoa(
  //   String.fromCharCode(
  //     ...(id.match(/[\dA-F]{2}/gi)?.map((s) => parseInt(s, 16)) || []),
  //   ),
  // );
  // In Node.JS:
  const sha256 = Buffer.from(id, 'hex').toString('base64')
  const command = new PutObjectCommand({
    Body: stream,
    ContentLength: fileSize,
    ChecksumSHA256: sha256,
    ...get_params(id),
  })
  await getS3Client().send(command)

  // use "@aws-sdk/lib-storage" if size not available:
  //
  // const multipartUpload = new Upload({
  //   client,
  //   params: {
  //     Body: stream,
  //     ...get_params(id),
  //   },
  // });
  // await multipartUpload.done();
}

export async function get_download_url(
  id: AssetId,
  filename?: string,
  expiresIn: number = 3600,
) {
  filename = filename || `${id.slice(0, 8)}.bin`
  const command = new GetObjectCommand({
    ...get_params(id),
    ResponseContentDisposition: `attachment;filename=${filename}`,
  })
  const url = await getSignedUrl(getS3Client() as any, command, { expiresIn })
  return url
}
