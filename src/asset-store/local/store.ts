// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import fs_sync from 'fs'
import fs from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { isAssetId, type AssetId } from '../../index.js'
import { getConfig } from '../config.js'

// Cache for store directory to avoid repeated async calls
let cachedStoreDir: string | null = null

export async function get_store_dir(): Promise<string> {
  if (!cachedStoreDir) {
    const config = await getConfig()
    cachedStoreDir = config.localPath ?? path.join(homedir(), '.playtiss')
    // Ensure directory exists
    fs_sync.mkdirSync(cachedStoreDir, { recursive: true })
  }
  return cachedStoreDir
}

// Initialize store directory asynchronously
get_store_dir().catch(console.error)

async function get_path(id: AssetId): Promise<[string, string]> {
  const store_dir = await get_store_dir()
  const folder_path = path.join(store_dir, id.slice(0, 2), id.slice(2, 4))
  const buffer_path = path.join(folder_path, id.slice(4))
  return [folder_path, buffer_path]
}

function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function toBuffer(byteArray: Uint8Array): Buffer {
  return Buffer.from(byteArray)
}

export async function has_buffer(id: AssetId): Promise<boolean> {
  if (!isAssetId(id)) {
    throw new Error('Invalid asset ID')
  }
  const [, buffer_path] = await get_path(id)
  try {
    await fs.access(buffer_path, fs_sync.constants.R_OK)
    return true
  }
  catch (e) {
    return false
  }
}

export async function fetch_buffer(id: AssetId): Promise<Uint8Array> {
  if (!isAssetId(id)) {
    throw new Error('Invalid asset ID')
  }
  const [, buffer_path] = await get_path(id)
  try {
    return toUint8Array(await fs.readFile(buffer_path))
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Asset not found')
    }
    if ((e as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('Permission denied')
    }
    throw e
  }
}

export async function save_buffer(buffer: Uint8Array, id: AssetId) {
  if (!isAssetId(id)) {
    throw new Error('Invalid asset ID')
  }
  const [folder_path, buffer_path] = await get_path(id)
  try {
    await fs.mkdir(folder_path, { recursive: true })
    await fs.writeFile(buffer_path, toBuffer(buffer))
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('Permission denied')
    }
    throw e
  }
}
