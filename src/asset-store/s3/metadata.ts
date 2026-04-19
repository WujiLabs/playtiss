// Copyright (c) 2026 Wuji Labs Inc
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import type { AssetId } from '@playtiss/core'

import type { UserActionId, VersionId } from '../../types/playtiss.js'
import {
  getS3Client,
  getS3ObjectParams,
  overrideS3Config as setOverrideConfig,
} from './s3-client.js'

// Re-export for backward compatibility
export const overrideS3Config = setOverrideConfig

// Helper to get S3 object parameters
function getObjectParams(id: AssetId): { Bucket: string, Key: string } {
  return getS3ObjectParams(`objects/${id}`)
}

function getReferencesParams(
  id: AssetId,
  type: 'assets' | 'actions' | 'versions',
): { Bucket: string, Key: string } {
  return getS3ObjectParams(`references/${id}/${type}`)
}

// Save asset with metadata (combines with putObject to avoid extra writes)
export async function saveAssetWithMetadata(
  buffer: Uint8Array,
  id: AssetId,
  mimeType?: string,
): Promise<void> {
  const params = getObjectParams(id)
  const metadata: Record<string, string> = {}

  if (mimeType) {
    metadata.mime_type = mimeType
  }

  try {
    const command = new PutObjectCommand({
      Body: new Uint8Array(buffer),
      ...params,
      Metadata: metadata,
    })

    await getS3Client().send(command)
    console.debug(
      `Asset ${id} saved to S3 with metadata: ${params.Bucket}/${params.Key} (${buffer.length} bytes)`,
    )
  }
  catch (error) {
    console.error('S3 saveAssetWithMetadata failed:', {
      assetId: id,
      bucket: params.Bucket,
      key: params.Key,
      bufferSize: buffer.length,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

// Get asset metadata from S3 object metadata
export async function getAssetMetadata(id: AssetId): Promise<{
  size_bytes: number
  mime_type?: string
  timestamp_created: Date
} | null> {
  const params = getObjectParams(id)

  try {
    const command = new HeadObjectCommand(params)
    const response = await getS3Client().send(command)

    return {
      size_bytes: response.ContentLength || 0,
      mime_type: response.Metadata?.mime_type,
      timestamp_created: response.LastModified || new Date(),
    }
  }
  catch (error) {
    if (S3ServiceException.isInstance(error)) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null
      }
      if (error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403) {
        console.debug(`S3 403 for ${id} — treating as not found (missing ListBucket permission)`)
        return null
      }
    }
    throw error
  }
}

// Save asset references as concatenated binary buffer
export async function saveAssetReferences(
  parentAssetId: AssetId,
  childAssetIds: AssetId[],
): Promise<void> {
  if (childAssetIds.length === 0) return

  const params = getReferencesParams(parentAssetId, 'assets')

  // Create concatenated buffer of asset IDs (each asset ID is 64 hex chars = 32 bytes)
  const ASSET_ID_LENGTH = 64 // hex characters
  const buffer = new Uint8Array(childAssetIds.length * ASSET_ID_LENGTH)

  for (let i = 0; i < childAssetIds.length; i++) {
    const assetIdBytes = new TextEncoder().encode(childAssetIds[i])
    if (assetIdBytes.length !== ASSET_ID_LENGTH) {
      throw new Error(
        `Invalid asset ID length: ${childAssetIds[i]} (expected ${ASSET_ID_LENGTH} chars)`,
      )
    }
    buffer.set(assetIdBytes, i * ASSET_ID_LENGTH)
  }

  try {
    const command = new PutObjectCommand({
      Body: buffer,
      ...params,
      Metadata: {
        parent_asset_id: parentAssetId,
        reference_count: childAssetIds.length.toString(),
        reference_type: 'assets',
      },
    })

    await getS3Client().send(command)
    console.debug(
      `Asset references saved: ${parentAssetId} -> ${childAssetIds.length} children`,
    )
  }
  catch (error) {
    console.error('S3 saveAssetReferences failed:', {
      parentAssetId,
      childCount: childAssetIds.length,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

// Get asset references from S3
export async function getAssetReferences(
  parentAssetId: AssetId,
): Promise<AssetId[]> {
  const params = getReferencesParams(parentAssetId, 'assets')

  try {
    const command = new GetObjectCommand(params)
    const response = await getS3Client().send(command)

    if (!response.Body) {
      return []
    }

    const buffer = await response.Body.transformToByteArray()
    const ASSET_ID_LENGTH = 64
    const childAssetIds: AssetId[] = []

    for (let i = 0; i < buffer.length; i += ASSET_ID_LENGTH) {
      const assetIdBytes = buffer.slice(i, i + ASSET_ID_LENGTH)
      const assetId = new TextDecoder().decode(assetIdBytes) as AssetId
      childAssetIds.push(assetId)
    }

    return childAssetIds
  }
  catch (error) {
    if (S3ServiceException.isInstance(error)) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return []
      }
    }
    throw error
  }
}

// Save asset-to-action references
export async function saveAssetToActionReferences(
  parentAssetId: AssetId,
  userActionIds: UserActionId[],
): Promise<void> {
  if (userActionIds.length === 0) return

  const params = getReferencesParams(parentAssetId, 'actions')

  // UserActionIds are UUIDs (36 chars fixed-length), so we can use efficient binary format
  const USER_ACTION_ID_LENGTH = 36
  const buffer = new Uint8Array(userActionIds.length * USER_ACTION_ID_LENGTH)

  for (let i = 0; i < userActionIds.length; i++) {
    const actionIdBytes = new TextEncoder().encode(userActionIds[i])
    if (actionIdBytes.length !== USER_ACTION_ID_LENGTH) {
      throw new Error(
        `Invalid user action ID length: ${userActionIds[i]} (expected ${USER_ACTION_ID_LENGTH} chars)`,
      )
    }
    buffer.set(actionIdBytes, i * USER_ACTION_ID_LENGTH)
  }

  try {
    const command = new PutObjectCommand({
      Body: buffer,
      ...params,
      Metadata: {
        parent_asset_id: parentAssetId,
        reference_count: userActionIds.length.toString(),
        reference_type: 'actions',
      },
    })

    await getS3Client().send(command)
    console.debug(
      `Asset-to-action references saved: ${parentAssetId} -> ${userActionIds.length} user actions`,
    )
  }
  catch (error) {
    console.error('S3 saveAssetToActionReferences failed:', {
      parentAssetId,
      actionCount: userActionIds.length,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

// Save asset-to-version references
export async function saveAssetToVersionReferences(
  parentAssetId: AssetId,
  versionIds: VersionId[],
): Promise<void> {
  if (versionIds.length === 0) return

  const params = getReferencesParams(parentAssetId, 'versions')

  // VersionIds are UUIDs (36 chars fixed-length), so we can use efficient binary format
  const VERSION_ID_LENGTH = 36
  const buffer = new Uint8Array(versionIds.length * VERSION_ID_LENGTH)

  for (let i = 0; i < versionIds.length; i++) {
    const versionIdBytes = new TextEncoder().encode(versionIds[i])
    if (versionIdBytes.length !== VERSION_ID_LENGTH) {
      throw new Error(
        `Invalid version ID length: ${versionIds[i]} (expected ${VERSION_ID_LENGTH} chars)`,
      )
    }
    buffer.set(versionIdBytes, i * VERSION_ID_LENGTH)
  }

  try {
    const command = new PutObjectCommand({
      Body: buffer,
      ...params,
      Metadata: {
        parent_asset_id: parentAssetId,
        reference_count: versionIds.length.toString(),
        reference_type: 'versions',
      },
    })

    await getS3Client().send(command)
    console.debug(
      `Asset-to-version references saved: ${parentAssetId} -> ${versionIds.length} versions`,
    )
  }
  catch (error) {
    console.error('S3 saveAssetToVersionReferences failed:', {
      parentAssetId,
      versionCount: versionIds.length,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
