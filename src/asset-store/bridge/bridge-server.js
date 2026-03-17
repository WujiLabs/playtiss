#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Sample Bridge Server for Playtiss Asset Store
 *
 * This server bridges UXP environments to Playtiss storage by:
 * 1. Receiving binary buffers and asset IDs from UXP clients
 * 2. Using the storage provider APIs directly to save/fetch assets
 * 3. Returning raw binary buffers to clients
 * 
 * Usage:
 *   node bridge-server.js [port] [storage-type]
 * 
 * Examples:
 *   node bridge-server.js 3000 local
 *   node bridge-server.js 3000 s3
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { fetchBuffer, hasBuffer, saveBuffer } from 'playtiss/asset-store/storage-factory';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Enable CORS for UXP environment
app.use(cors({
  origin: true, // Allow any origin for localhost development
  methods: ['GET', 'POST', 'HEAD'],
  allowedHeaders: ['Content-Type'],
}));

/**
 * GET /assets?id={assetId} - Fetch asset buffer
 */
app.get('/assets', async (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Asset ID is required' });
    }

    console.log(`Bridge: Fetching asset ${id}`);
    
    const buffer = await fetchBuffer(id);
    
    console.log(`Bridge: Fetched asset ${id} (${buffer.length} bytes)`);
    
    // Return raw binary buffer
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
    
  } catch (error) {
    console.error('Bridge fetch error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch asset', 
      details: error.message 
    });
  }
});

/**
 * HEAD /assets?id={assetId} - Check if asset exists
 */
app.head('/assets', async (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).end();
    }

    console.log(`Bridge: Checking asset ${id}`);
    
    const exists = await hasBuffer(id);
    
    if (exists) {
      res.status(200).end();
    } else {
      res.status(404).end();
    }
    
  } catch (error) {
    console.error('Bridge hasBuffer error:', error.message);
    res.status(500).end();
  }
});

// Store for chunked uploads
const chunkStore = new Map();

/**
 * POST /assets - Save asset buffer with references
 * 
 * Expects multipart/form-data with:
 * - buffer: Binary asset data (required)
 * - id: Asset ID (required)
 * - assetReferences: JSON array of asset IDs (optional)
 * - actionReferences: JSON array of action IDs (optional)
 * - versionReferences: JSON array of version IDs (optional)
 */
app.post('/assets', upload.single('buffer'), async (req, res) => {
  try {
    const { id } = req.body;
    const bufferFile = req.file;
    
    if (!id) {
      return res.status(400).json({ error: 'Asset ID is required' });
    }
    
    if (!bufferFile) {
      return res.status(400).json({ error: 'Buffer data is required' });
    }

    console.log(`Bridge: Saving asset ${id} (${bufferFile.buffer.length} bytes)`);
    
    // Parse references from form data
    const references = {};
    
    if (req.body.assetReferences) {
      try {
        references.assetReferences = JSON.parse(req.body.assetReferences);
        console.log(`Bridge: Asset has ${references.assetReferences.length} asset references`);
      } catch (e) {
        console.warn('Bridge: Invalid assetReferences JSON:', e.message);
      }
    }
    
    if (req.body.actionReferences) {
      try {
        references.actionReferences = JSON.parse(req.body.actionReferences);
        console.log(`Bridge: Asset has ${references.actionReferences.length} action references`);
      } catch (e) {
        console.warn('Bridge: Invalid actionReferences JSON:', e.message);
      }
    }
    
    if (req.body.versionReferences) {
      try {
        references.versionReferences = JSON.parse(req.body.versionReferences);
        console.log(`Bridge: Asset has ${references.versionReferences.length} version references`);
      } catch (e) {
        console.warn('Bridge: Invalid versionReferences JSON:', e.message);
      }
    }

    // Use storage factory to save the asset
    await saveBuffer(
      bufferFile.buffer, 
      id, 
      Object.keys(references).length > 0 ? references : undefined
    );
    
    console.log(`Bridge: Saved asset ${id} successfully`);
    
    res.json({ 
      success: true, 
      id,
      size: bufferFile.buffer.length,
      references: Object.keys(references).length > 0 ? references : undefined
    });
    
  } catch (error) {
    console.error('Bridge save error:', error.message);
    res.status(500).json({ 
      error: 'Failed to save asset', 
      details: error.message 
    });
  }
});

/**
 * POST /assets/chunk - Handle chunked upload
 * 
 * Expects multipart/form-data with:
 * - buffer: Binary chunk data (required)
 * - id: Asset ID (required)
 * - chunkIndex: Current chunk index (required)
 * - totalChunks: Total number of chunks (required) 
 * - chunkSize: Size of this chunk (required)
 * - totalSize: Total size of complete file (required)
 * - assetReferences: JSON array of asset IDs (optional, only on first chunk)
 * - actionReferences: JSON array of action IDs (optional, only on first chunk)
 * - versionReferences: JSON array of version IDs (optional, only on first chunk)
 */
app.post('/assets/chunk', upload.single('buffer'), async (req, res) => {
  try {
    const { id, chunkIndex, totalChunks, chunkSize, totalSize } = req.body;
    const bufferFile = req.file;
    
    if (!id || chunkIndex === undefined || !totalChunks || !bufferFile) {
      return res.status(400).json({ error: 'Missing required chunk parameters' });
    }

    const chunkIdx = parseInt(chunkIndex);
    const totalChunksNum = parseInt(totalChunks);
    const totalSizeNum = parseInt(totalSize);
    
    console.log(`Bridge: Receiving chunk ${chunkIdx + 1}/${totalChunksNum} for asset ${id} (${bufferFile.buffer.length} bytes)`);
    
    // Initialize chunk storage for this asset
    if (!chunkStore.has(id)) {
      chunkStore.set(id, {
        chunks: new Array(totalChunksNum),
        totalSize: totalSizeNum,
        receivedChunks: 0,
        references: null
      });
    }
    
    const assetChunks = chunkStore.get(id);
    
    // Store this chunk
    assetChunks.chunks[chunkIdx] = bufferFile.buffer;
    assetChunks.receivedChunks++;
    
    // Store references from first chunk
    if (chunkIdx === 0) {
      const references = {};
      
      if (req.body.assetReferences) {
        try {
          references.assetReferences = JSON.parse(req.body.assetReferences);
        } catch (e) {
          console.warn('Bridge: Invalid assetReferences JSON:', e.message);
        }
      }
      
      if (req.body.actionReferences) {
        try {
          references.actionReferences = JSON.parse(req.body.actionReferences);
        } catch (e) {
          console.warn('Bridge: Invalid actionReferences JSON:', e.message);
        }
      }
      
      if (req.body.versionReferences) {
        try {
          references.versionReferences = JSON.parse(req.body.versionReferences);
        } catch (e) {
          console.warn('Bridge: Invalid versionReferences JSON:', e.message);
        }
      }
      
      assetChunks.references = Object.keys(references).length > 0 ? references : null;
    }
    
    // Check if all chunks received
    if (assetChunks.receivedChunks === totalChunksNum) {
      console.log(`Bridge: All chunks received for ${id}, assembling and saving...`);
      
      // Combine all chunks into single buffer
      const fullBuffer = new Uint8Array(assetChunks.totalSize);
      let offset = 0;
      
      for (let i = 0; i < totalChunksNum; i++) {
        const chunk = assetChunks.chunks[i];
        if (!chunk) {
          throw new Error(`Missing chunk ${i} for asset ${id}`);
        }
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Save the complete asset
      await saveBuffer(fullBuffer, id, assetChunks.references);
      
      // Clean up chunk storage
      chunkStore.delete(id);
      
      console.log(`Bridge: Completed chunked upload for ${id} (${fullBuffer.length} bytes)`);
      
      res.json({ 
        success: true, 
        id,
        totalSize: fullBuffer.length,
        chunksReceived: totalChunksNum,
        references: assetChunks.references
      });
    } else {
      // Still waiting for more chunks
      res.json({ 
        success: true, 
        id,
        chunkIndex: chunkIdx,
        chunksReceived: assetChunks.receivedChunks,
        totalChunks: totalChunksNum
      });
    }
    
  } catch (error) {
    console.error('Bridge chunk upload error:', error.message);
    
    // Clean up on error
    if (req.body.id) {
      chunkStore.delete(req.body.id);
    }
    
    res.status(500).json({ 
      error: 'Failed to process chunk', 
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((error, _req, res, _next) => {
  console.error('Bridge server error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: error.message 
  });
});

// Start server
const port = parseInt(process.argv[2]) || 3000;
const storageType = process.argv[3] || process.env.PLAYTISS_STORAGE_TYPE || 's3';

// Set storage type for this bridge server
process.env.PLAYTISS_STORAGE_TYPE = storageType;

app.listen(port, () => {
  console.log(`🌉 Playtiss Bridge Server started`);
  console.log(`📡 Listening on http://localhost:${port}`);
  console.log(`💾 Storage type: ${storageType}`);
  console.log(`🔗 API endpoint: http://localhost:${port}/assets`);
  console.log('');
  console.log('📋 Usage in UXP:');
  console.log(`   setBridgeStorageProvider({`);
  console.log(`     baseUrl: "http://localhost:${port}",`);
  console.log(`     apiPath: "/assets"`);
  console.log(`   });`);
});