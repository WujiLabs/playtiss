#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: Inspect Asset
 *
 * Loads and displays an asset directly from the content-addressable storage.
 * Usage: tsx dev-tools/inspect-asset.ts <asset-id>
 */

import dotenv from 'dotenv'

// Load environment configuration BEFORE any playtiss imports
dotenv.config()

import { isAssetId } from '@playtiss/core'
import { load } from 'playtiss/asset-store'

async function inspectAsset(assetId: string) {
  try {
    const storageType = process.env.PLAYTISS_STORAGE_TYPE || 'local'
    console.log(`🔍 Inspecting Asset: ${assetId}`)
    console.log(`🗄️  Storage Backend: ${storageType.toUpperCase()}`)

    if (storageType === 's3') {
      console.log(`   S3 Bucket: ${process.env.S3_BUCKET || '(not set)'}`)
      console.log(`   AWS Region: ${process.env.AWS_REGION || '(not set)'}`)
      console.log(`   AWS Profile: ${process.env.AWS_PROFILE || '(not set)'}`)
    }
    else {
      console.log(
        `   Local Path: ${process.env.PLAYTISS_LOCAL_PATH || '~/.playtiss'}`,
      )
    }

    console.log('━'.repeat(60))

    // Validate asset ID format
    if (!isAssetId(assetId)) {
      throw new Error(
        `Invalid asset ID format: ${assetId}. Expected a CID string.`,
      )
    }

    console.log(`🔗 Asset ID: ${assetId}`)

    if (storageType === 's3') {
      console.log(`🗂️  Expected S3 Key: objects/${assetId}`)
    }

    console.log()

    // Load asset using playtiss
    const jsonData = await load(assetId)

    console.log(`🔤 Type: Asset (JSON)`)
    console.log()

    console.log(`📝 Content:`)
    console.log('─'.repeat(40))
    console.log(JSON.stringify(jsonData, null, 2))
  }
  catch (error: any) {
    const storageType = process.env.PLAYTISS_STORAGE_TYPE || 'local'
    console.error(`❌ Error inspecting asset: ${error.message}`)

    if (error.code === 'ENOENT') {
      console.error(
        `💡 Asset not found in local storage. Check if the asset ID is correct.`,
      )
    }
    else if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
      console.error(
        `💡 Asset not found in S3 storage. Check if the asset ID is correct.`,
      )
    }
    else if (
      error.message
      && error.message.includes('not found in storage')
    ) {
      console.error(
        `💡 Asset not found in ${storageType.toUpperCase()} storage, but object URI should be:`,
      )
      console.error(
        `   https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/objects/${assetId.slice(1)}`,
      )
      console.error(
        `💡 This might be an AWS credentials or permissions issue.`,
      )
      console.error(
        `💡 Try running: aws s3 ls s3://${process.env.S3_BUCKET}/objects/${assetId.slice(1)}`,
      )
    }
    else if (
      error.name === 'AuthorizationHeaderMalformed'
      || error.Code === 'AuthorizationHeaderMalformed'
    ) {
      console.error(
        `💡 AWS credentials issue. Check your AWS_PROFILE or AWS credentials.`,
      )
    }
    else if (error.name === 'NetworkingError' || error.code === 'ENOTFOUND') {
      console.error(
        `💡 Network connection issue. Check your internet connection and AWS region.`,
      )
    }
    else if (error.name === 'AccessDenied' || error.Code === 'AccessDenied') {
      console.error(
        `💡 AWS access denied. Check your AWS permissions for the S3 bucket.`,
      )
    }
    else if (error.name === 'CredentialsProviderError') {
      console.error(
        `💡 AWS credentials provider error. Check your AWS profile configuration.`,
      )
    }
    else {
      console.error(`💡 Full error details:`)
      console.error(
        JSON.stringify(
          {
            name: error.name,
            code: error.code,
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 3).join('\n'),
            $fault: error.$fault,
            $metadata: error.$metadata,
          },
          null,
          2,
        ),
      )
    }
    process.exit(1)
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const assetId = process.argv[2]

  if (!assetId) {
    console.error('Usage: tsx dev-tools/inspect-asset.ts <asset-id>')
    console.error('')
    console.error('Example:')
    console.error('  tsx dev-tools/inspect-asset.ts baguqeera...')
    process.exit(1)
  }

  inspectAsset(assetId)
}
