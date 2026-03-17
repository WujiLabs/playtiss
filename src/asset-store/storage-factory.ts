// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId, isAssetId } from '../index.js'
import { getConfig, type BridgeConfig, type S3Config, type StorageConfig } from './config.js'
import { BridgeStorageProvider } from './bridge/provider.js'
import { LocalStorageProvider } from './local/index.js'
import { S3StorageProvider } from './s3/index.js'
import {
  type AssetReferences,
  type StorageProvider,
} from './storage-provider.js'

// Re-export for backward compatibility
export type { AssetReferences, StorageProvider } from './storage-provider.js'

let currentProvider: StorageProvider | null = null

export async function getStorageProvider(): Promise<StorageProvider> {
  if (!currentProvider) {
    try {
      const config = await getConfig()
      console.info(`Initializing storage provider: type=${config.type}`)

      if (config.type === 'local') {
        currentProvider = new LocalStorageProvider(config)
      }
      else if (config.type === 's3') {
        currentProvider = new S3StorageProvider(config)
      }
      else if (config.type === 'bridge') {
        currentProvider = new BridgeStorageProvider(config)
      }
      else {
        throw new Error(
          `Unknown storage type: ${config.type}. Supported types: 'local', 's3', 'bridge'`,
        )
      }

      console.info(`Storage provider initialized successfully: ${config.type}`)
    }
    catch (error: any) {
      console.error('Failed to initialize storage provider:', error.message)
      throw new Error(
        `Storage provider initialization failed: ${error.message}`,
      )
    }
  }
  return currentProvider
}

export function resetStorageProvider() {
  currentProvider = null
}

// ===================================================================
// WEB ENVIRONMENT API - Direct provider registration
// ===================================================================

/**
 * Register a custom S3 storage provider with explicit credentials (web environments)
 * This bypasses the normal config-based provider creation
 */
export function setS3WebStorageProvider(s3Config: S3Config): void {
  // Create a StorageConfig that the S3StorageProvider expects
  const storageConfig: StorageConfig = {
    type: 's3',
    s3: s3Config,
  }

  currentProvider = new S3StorageProvider(storageConfig)
  console.info('S3 web storage provider registered with explicit credentials')
}

/**
 * Register a custom local storage provider (web environments using IndexedDB, etc.)
 */
export function setLocalWebStorageProvider(localPath?: string): void {
  const storageConfig: StorageConfig = {
    type: 'local',
    localPath,
  }

  currentProvider = new LocalStorageProvider(storageConfig)
  console.info('Local web storage provider registered')
}

/**
 * Register a bridge storage provider for UXP environments
 */
export function setBridgeStorageProvider(bridgeConfig: BridgeConfig): void {
  const storageConfig: StorageConfig = {
    type: 'bridge',
    bridge: bridgeConfig,
  }

  currentProvider = new BridgeStorageProvider(storageConfig)
  console.info('Bridge storage provider registered for UXP environment')
}

/**
 * Register any custom storage provider directly
 */
export function setCustomStorageProvider(provider: StorageProvider): void {
  currentProvider = provider
  console.info('Custom storage provider registered')
}

// Export convenience functions that use the current provider
export async function hasBuffer(id: AssetId): Promise<boolean> {
  if (!isAssetId(id)) {
    return false
  }
  const provider = await getStorageProvider()
  return provider.hasBuffer(id)
}

export async function fetchBuffer(id: AssetId): Promise<Uint8Array> {
  if (!isAssetId(id)) {
    throw new Error('Invalid asset ID')
  }
  const provider = await getStorageProvider()
  return provider.fetchBuffer(id)
}

export async function saveBuffer(
  buffer: Uint8Array,
  id: AssetId,
  references?: AssetReferences,
): Promise<void> {
  if (!isAssetId(id)) {
    throw new Error('Invalid asset ID')
  }
  const provider = await getStorageProvider()
  return provider.saveBuffer(buffer, id, references)
}

// Asset references and database functions are now handled by the storage providers themselves
// - For local storage: LocalStorageProvider handles SQLite database operations
// - For S3 storage: S3StorageProvider handles cloud-based references
// Use getStorageProvider() and call the methods directly on the provider instance
