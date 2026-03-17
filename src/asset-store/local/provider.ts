// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId } from '../../index.js'
import { type StorageConfig } from '../config.js'
import {
  type AssetReferences,
  type StorageProvider,
} from '../storage-provider.js'
import {
  saveAssetRecord,
  saveAssetReferences,
  saveAssetToActionReferences,
  saveAssetToVersionReferences,
} from './asset-db.js'
import { fetch_buffer, has_buffer, save_buffer } from './store.js'

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly config: StorageConfig) {
    // Validation happens lazily when operations are actually called
    console.info(`LocalStorageProvider initialized: type=local`)
  }

  async hasBuffer(id: AssetId): Promise<boolean> {
    try {
      return await has_buffer(id)
    }
    catch (error: any) {
      const message = `LocalStorageProvider.hasBuffer failed for asset ${id}: ${error.message}`
      console.error(message)
      if (error.message?.includes('Cannot find module')) {
        throw new Error(
          `Local storage requires Node.js environment. Use PLAYTISS_STORAGE_TYPE=s3 for web environments.`,
        )
      }
      throw error
    }
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    try {
      return await fetch_buffer(id)
    }
    catch (error: any) {
      const message = `LocalStorageProvider.fetchBuffer failed for asset ${id}: ${error.message}`
      console.error(message)
      if (error.message?.includes('Cannot find module')) {
        throw new Error(
          `Local storage requires Node.js environment. Use PLAYTISS_STORAGE_TYPE=s3 for web environments.`,
        )
      }
      throw error
    }
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    try {
      await save_buffer(buffer, id)
      // Save to database after successful storage
      await saveAssetRecord(id, buffer)

      // Save references if provided
      if (references) {
        if (
          references.assetReferences
          && references.assetReferences.length > 0
        ) {
          await saveAssetReferences(id, references.assetReferences)
          console.debug(
            `Saved ${references.assetReferences.length} asset references for ${id}`,
          )
        }
        if (
          references.actionReferences
          && references.actionReferences.length > 0
        ) {
          await saveAssetToActionReferences(id, references.actionReferences)
          console.debug(
            `Saved ${references.actionReferences.length} action references for ${id}`,
          )
        }
        if (
          references.versionReferences
          && references.versionReferences.length > 0
        ) {
          await saveAssetToVersionReferences(id, references.versionReferences)
          console.debug(
            `Saved ${references.versionReferences.length} version references for ${id}`,
          )
        }
      }

      console.debug(
        `LocalStorageProvider successfully saved asset ${id} (${buffer.length} bytes)`,
      )
    }
    catch (error: any) {
      const message = `LocalStorageProvider.saveBuffer failed for asset ${id}: ${error.message}`
      console.error(message)
      if (error.message?.includes('Cannot find module')) {
        throw new Error(
          `Local storage requires Node.js environment. Use PLAYTISS_STORAGE_TYPE=s3 for web environments.`,
        )
      }
      throw error
    }
  }
}
