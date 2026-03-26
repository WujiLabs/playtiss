// Copyright (c) 2026 Wuji Labs Inc
import { type AssetId } from '../../index.js'
import { type StorageConfig } from '../config.js'
import {
  type AssetReferences,
  type StorageProvider,
} from '../storage-provider.js'

export class BridgeStorageProvider implements StorageProvider {
  private readonly baseUrl: string
  private readonly apiPath: string

  constructor(config: StorageConfig) {
    if (config.type !== 'bridge' || !config.bridge) {
      throw new Error('BridgeStorageProvider requires bridge configuration')
    }
    this.baseUrl = config.bridge.baseUrl.replace(/\/$/, '') // remove trailing slash
    this.apiPath = config.bridge.apiPath || '/api/assets'
  }

  private getApiUrl(): string {
    return `${this.baseUrl}${this.apiPath}`
  }

  async hasBuffer(id: AssetId): Promise<boolean> {
    try {
      const response = await fetch(`${this.getApiUrl()}?id=${encodeURIComponent(id)}`, {
        method: 'HEAD',
      })
      return response.ok
    }
    catch (error) {
      console.debug(`Bridge hasBuffer failed for asset ${id}:`,
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }

  async fetchBuffer(id: AssetId): Promise<Uint8Array> {
    try {
      const response = await fetch(`${this.getApiUrl()}?id=${encodeURIComponent(id)}`, {
        method: 'GET',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      return new Uint8Array(arrayBuffer)
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`Bridge fetchBuffer failed for asset ${id}:`, {
        assetId: id,
        baseUrl: this.baseUrl,
        error: errorMessage,
      })
      throw new Error(`Failed to fetch asset ${id} from bridge server: ${errorMessage}`)
    }
  }

  async saveBuffer(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    try {
      // For large files (>10MB), use chunked upload to avoid UXP WebSocket limits
      const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB chunks

      if (buffer.length > CHUNK_SIZE) {
        await this.saveBufferChunked(buffer, id, references)
      }
      else {
        await this.saveBufferDirect(buffer, id, references)
      }

      console.debug(`Bridge asset saved: ${id} (${buffer.length} bytes)`)
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`Bridge saveBuffer failed for asset ${id}:`, {
        assetId: id,
        bufferSize: buffer.length,
        baseUrl: this.baseUrl,
        error: errorMessage,
      })
      throw new Error(`Failed to save asset ${id} to bridge server: ${errorMessage}`)
    }
  }

  private async saveBufferDirect(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    const formData = new FormData()

    // Always send buffer as binary data
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    formData.append('buffer', blob)
    formData.append('id', id)

    // Add references as separate form fields if provided
    if (references?.assetReferences) {
      formData.append('assetReferences', JSON.stringify(references.assetReferences))
    }
    if (references?.actionReferences) {
      formData.append('actionReferences', JSON.stringify(references.actionReferences))
    }
    if (references?.versionReferences) {
      formData.append('versionReferences', JSON.stringify(references.versionReferences))
    }

    const response = await fetch(this.getApiUrl(), {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
  }

  private async saveBufferChunked(
    buffer: Uint8Array,
    id: AssetId,
    references?: AssetReferences,
  ): Promise<void> {
    const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB chunks
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE)

    console.debug(`Bridge: Uploading ${id} in ${totalChunks} chunks (${buffer.length} bytes total)`)

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, buffer.length)
      const chunk = buffer.slice(start, end)

      const formData = new FormData()
      const blob = new Blob([chunk], { type: 'application/octet-stream' })
      formData.append('buffer', blob)
      formData.append('id', id)
      formData.append('chunkIndex', chunkIndex.toString())
      formData.append('totalChunks', totalChunks.toString())
      formData.append('chunkSize', chunk.length.toString())
      formData.append('totalSize', buffer.length.toString())

      // Only send references with the first chunk
      if (chunkIndex === 0) {
        if (references?.assetReferences) {
          formData.append('assetReferences', JSON.stringify(references.assetReferences))
        }
        if (references?.actionReferences) {
          formData.append('actionReferences', JSON.stringify(references.actionReferences))
        }
        if (references?.versionReferences) {
          formData.append('versionReferences', JSON.stringify(references.versionReferences))
        }
      }

      const response = await fetch(`${this.getApiUrl()}/chunk`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} (chunk ${chunkIndex + 1}/${totalChunks})`)
      }

      console.debug(`Bridge: Uploaded chunk ${chunkIndex + 1}/${totalChunks} for ${id}`)
    }
  }
}
