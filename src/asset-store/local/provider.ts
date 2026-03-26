// Copyright (c) 2026 Wuji Labs Inc
import fs_sync from 'fs'
import fs from 'fs/promises'
import { homedir } from 'os'
import path from 'path'

import { type AssetId, isAssetId } from '../../index.js'
import { getConfig, type StorageConfig } from '../config.js'
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

/**
 * Local filesystem storage provider for Playtiss assets.
 *
 * Stores CID-addressed content as files organized in a two-level
 * directory hierarchy derived from the asset identifier prefix.
 * Metadata and cross-asset references are persisted to a co-located
 * SQLite database (see asset-db).
 */
export class LocalStorageProvider implements StorageProvider {
  /** Resolved root directory – populated lazily on first I/O call. */
  private storeDir: string | null = null

  constructor(private readonly config: StorageConfig) {
    console.info(`LocalStorageProvider initialized: type=local`)
    // Kick off (but don't block on) directory resolution so
    // the first real operation is fast in the common case.
    this.resolveStoreDir().catch(console.error)
  }

  // ---------------------------------------------------------------------------
  // StorageProvider interface
  // ---------------------------------------------------------------------------

  async hasBuffer(id: AssetId): Promise<boolean> {
    this.assertValidId(id)
    const bufferPath = await this.bufferPath(id)
    try {
      await fs.access(bufferPath, fs_sync.constants.R_OK)
      return true
    }
    catch {
      return false
    }
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    this.assertValidId(id)
    const bufferPath = await this.bufferPath(id)
    try {
      const buf = await fs.readFile(bufferPath)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error(`Asset ${id} not found in local storage`)
      if (code === 'EACCES') throw new Error(`Permission denied reading asset ${id}`)
      throw e
    }
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    this.assertValidId(id)
    try {
      // Write blob to disk
      const [folderPath, bufferPath] = await this.assetPaths(id)
      await fs.mkdir(folderPath, { recursive: true })
      await fs.writeFile(bufferPath, Buffer.from(buffer))

      // Persist metadata row
      await saveAssetRecord(id, buffer)

      // Persist any supplied cross-asset references
      if (references) {
        await this.persistReferences(id, references)
      }

      console.debug(
        `LocalStorageProvider saved asset ${id} (${buffer.length} bytes)`,
      )
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`Permission denied writing asset ${id}`)
      }
      throw e
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Lazily resolve (and cache) the root storage directory.
   * Falls back to `~/.playtiss` when no explicit path is configured.
   */
  private async resolveStoreDir(): Promise<string> {
    if (!this.storeDir) {
      const cfg = await getConfig()
      this.storeDir = cfg.localPath ?? path.join(homedir(), '.playtiss')
      fs_sync.mkdirSync(this.storeDir, { recursive: true })
    }
    return this.storeDir
  }

  /** Return `[folderPath, filePath]` for the given asset. */
  private async assetPaths(id: AssetId): Promise<[string, string]> {
    const dir = await this.resolveStoreDir()
    const folder = path.join(dir, id.slice(0, 2), id.slice(2, 4))
    const file = path.join(folder, id.slice(4))
    return [folder, file]
  }

  /** Shorthand that only needs the file path. */
  private async bufferPath(id: AssetId): Promise<string> {
    const [, p] = await this.assetPaths(id)
    return p
  }

  private assertValidId(id: AssetId): void {
    if (!isAssetId(id)) throw new Error(`Invalid asset ID: ${id}`)
  }

  /** Persist the three reference flavours in parallel when present. */
  private async persistReferences(
    id: AssetId,
    refs: AssetReferences,
  ): Promise<void> {
    const tasks: Promise<void>[] = []

    if (refs.assetReferences?.length) {
      tasks.push(saveAssetReferences(id, refs.assetReferences))
    }
    if (refs.actionReferences?.length) {
      tasks.push(saveAssetToActionReferences(id, refs.actionReferences))
    }
    if (refs.versionReferences?.length) {
      tasks.push(saveAssetToVersionReferences(id, refs.versionReferences))
    }

    if (tasks.length) {
      await Promise.all(tasks)
      console.debug(`LocalStorageProvider persisted ${tasks.length} reference set(s) for ${id}`)
    }
  }
}
