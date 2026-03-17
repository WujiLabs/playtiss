# Bridge Storage Provider

The Bridge Storage Provider enables Playtiss to work in restricted environments like UXP (Adobe extensions) where AWS SDK is not available. It communicates with a localhost bridge server that handles actual storage operations.

## Quick Start

### 1. Start the Bridge Server

```bash
cd src/asset-store/bridge
npm install
npm run dev        # Uses local storage
# or
npm run dev:s3     # Uses S3 storage
```

### 2. Configure UXP Environment

```typescript
import { setBridgeStorageProvider } from "playtiss/asset-store";

// Configure bridge to communicate with localhost server
setBridgeStorageProvider({
  baseUrl: "http://localhost:3000",
  apiPath: "/assets", // optional, defaults to "/api/assets"
});

// Now use normal asset-store operations
import { store, load } from "playtiss/asset-store";

const assetId = await store({ message: "Hello from UXP!" });
const asset = await load(assetId);
```

## Bridge Server

### Running the Bridge Server

```bash
# Install dependencies (including playtiss package)
npm install

# Start server (defaults to port 3000, local storage)
node bridge-server.js

# Custom port and storage type
node bridge-server.js 3000 s3
node bridge-server.js 8080 local
```

### API Endpoints

The bridge server provides a simple HTTP API:

- **GET /assets?id={assetId}** - Fetch asset as binary buffer
- **HEAD /assets?id={assetId}** - Check if asset exists
- **POST /assets** - Save asset with multipart/form-data (files <10MB)
- **POST /assets/chunk** - Save asset chunk (for files >10MB)

### POST Request Format

```javascript
const formData = new FormData();
formData.append('buffer', blob);           // Binary asset data (required)
formData.append('id', assetId);            // Asset ID (required)
formData.append('assetReferences', JSON.stringify(refs));    // Optional
formData.append('actionReferences', JSON.stringify(refs));   // Optional  
formData.append('versionReferences', JSON.stringify(refs));  // Optional
```

## How It Works

### Simplified Protocol
- **All assets** are transferred as binary buffers (no JSON parsing needed)
- **UXP client** handles all serialization using existing asset-store logic
- **Bridge server** just passes buffers to the storage provider APIs
- **References** are sent as separate form fields and handled server-side

### Asset Flow
1. UXP client serializes asset to buffer using asset-store logic
2. Client uploads buffer + asset ID + references via multipart/form-data
3. Bridge server receives buffer and calls `provider.saveBuffer(buffer, id, refs)`
4. Storage provider (S3/local) handles actual storage and reference tracking

### Loading Flow
1. UXP client requests asset by ID
2. Bridge server calls `provider.fetchBuffer(id)` 
3. Bridge server returns raw buffer
4. UXP client deserializes buffer using asset-store logic

## Environment Variables

The bridge server respects the same environment variables as Playtiss:

```bash
# Storage configuration
PLAYTISS_STORAGE_TYPE=local|s3|bridge
PLAYTISS_LOCAL_PATH=/path/to/local/storage

# S3 configuration (if using S3)
S3_BUCKET=your-bucket-name
AWS_REGION=us-west-1
AWS_PROFILE=your-profile
```

## Features

### Chunked Upload Support
- **Automatic chunking**: Files >10MB are automatically split into 10MB chunks
- **UXP compatible**: Avoids WebSocket payload limits in UXP Developer Tools
- **Progress tracking**: Console logs show upload progress for large files
- **Error recovery**: Failed chunks can be retried independently

### Performance Benefits
- **Simple Protocol**: Just binary buffers, no complex JSON serialization
- **Full Compatibility**: Uses existing storage provider APIs
- **Reference Support**: Handles all reference types server-side  
- **Environment Agnostic**: Works with any storage backend (S3, local, etc.)
- **Minimal Overhead**: Direct buffer transfer with optional chunking