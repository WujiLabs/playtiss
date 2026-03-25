#!/usr/bin/env node
/**
 * Creates the test database for integration testing.
 * Starts graphql-server, creates workflow via GraphQL, saves the DB.
 */
import { spawn } from 'child_process'
import { cpSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const GQL_URL = 'http://localhost:4000/graphql'

async function gql(query, variables) {
  const body = JSON.stringify({ query, variables })
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const json = await res.json()
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2))
    throw new Error(json.errors[0].message)
  }
  return json.data
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(GQL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"{__typename}"}' })
      return
    } catch { await new Promise(r => setTimeout(r, 1000)) }
  }
  throw new Error('Server did not start in time')
}

// Set AWS config before importing playtiss store
process.env.AWS_REGION = 'us-west-1'
// AWS_PROFILE loaded from environment or .env
// S3_BUCKET loaded from environment or .env
process.env.PLAYTISS_STORAGE_TYPE = 's3'

// Import playtiss store to compute proper CID-keyed pipeline
const { store } = await import('../src/dist/asset-store/index.js')

// Setup — write directly to the output path to avoid WAL copy issues
const tempDir = mkdtempSync(join(tmpdir(), 'playtiss-seed-'))
const outputDb = join(PROJECT_ROOT, 'graphql-server', 'playtiss-test-add3.db')
// Remove stale DB files
import { unlinkSync, existsSync } from 'fs'
for (const ext of ['', '-wal', '-shm']) {
  try { unlinkSync(outputDb + ext) } catch {}
}
const tempDb = outputDb
process.env.PLAYTISS_DB_PATH = tempDb

console.log('Starting graphql-server with fresh DB...')
const server = spawn('npm', ['start'], {
  cwd: join(PROJECT_ROOT, 'graphql-server'),
  env: { ...process.env, PLAYTISS_DB_PATH: tempDb },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', d => serverLog += d)
server.stderr.on('data', d => serverLog += d)

const cleanup = () => { try { server.kill() } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', cleanup)

try {
  await waitForServer()
  console.log('Server ready.')
  await new Promise(r => setTimeout(r, 2000))

  // Create the add-two action
  console.log('Creating add-two action...')
  const addTwoResult = await gql(`mutation { createAction(name: "Add Two Numbers", description: "Adds two integers") { id } }`)
  const addTwoId = addTwoResult.createAction.id
  console.log(`  add-two action id: ${addTwoId}`)

  // Create the add-three workflow action
  console.log('Creating add-three workflow action...')
  const addThreeResult = await gql(`mutation { createAction(name: "Add Three Numbers", description: "Adds three integers") { id } }`)
  const addThreeId = addThreeResult.createAction.id
  console.log(`  add-three action id: ${addThreeId}`)

  // Build proper Pipeline structure with CID-keyed nodes and edges
  console.log('Building workflow definition...')

  const now = Date.now()

  // Create Node objects and store to get CIDs
  const node1 = {
    asset_type: 'pipeline_node',
    action: addTwoId,
    use_task_creator: false,
    timestamp: now,
  }
  const node2 = {
    asset_type: 'pipeline_node',
    action: addTwoId,
    use_task_creator: false,
    timestamp: now + 1,  // Different timestamp for unique CID
  }
  const node1Id = await store(node1)
  const node2Id = await store(node2)
  console.log(`  node1 (add A+B) CID: ${node1Id}`)
  console.log(`  node2 (add result+C) CID: ${node2Id}`)

  // Create Edge objects and store to get CIDs
  const edges = [
    { asset_type: 'pipeline_edge', source: { node: null, name: 'A' }, target: { node: node1Id, name: 'A' } },
    { asset_type: 'pipeline_edge', source: { node: null, name: 'B' }, target: { node: node1Id, name: 'B' } },
    { asset_type: 'pipeline_edge', source: { node: node1Id, name: 'output' }, target: { node: node2Id, name: 'A' } },
    { asset_type: 'pipeline_edge', source: { node: null, name: 'C' }, target: { node: node2Id, name: 'B' } },
    { asset_type: 'pipeline_edge', source: { node: node2Id, name: 'output' }, target: { node: null, name: 'result' } },
  ]
  const edgeEntries = {}
  for (const edge of edges) {
    const edgeId = await store(edge)
    edgeEntries[edgeId] = edge
  }

  // Build the Pipeline object
  const pipeline = {
    asset_type: 'action',
    timestamp: now,
    description: 'Add three numbers: (A+B)+C',
    input_shape: { A: 'number', B: 'number', C: 'number' },
    output_shape: { result: 'number' },
    nodes: {
      [node1Id]: node1,
      [node2Id]: node2,
    },
    edges: edgeEntries,
  }

  // Store via GraphQL mutation (which also creates the version)
  console.log('Creating workflow definition version...')
  const wfResult = await gql(
    `mutation($def: DictJSONAsset!) {
      createWorkflowDefinitionVersion(actionId: "${addThreeId}", workflowDefinition: $def, commitMessage: "Initial workflow definition") {
        id
      }
    }`,
    { def: pipeline }
  )
  console.log(`  workflow definition version: ${wfResult.createWorkflowDefinitionVersion.id}`)

  // ================================================================
  // Split-Merge Workflow: input → split → add_two → merge → output
  // ================================================================
  console.log('\nCreating split-merge workflow action...')
  const splitMergeResult = await gql(`mutation { createAction(name: "Split Add Two", description: "Splits array, adds A+B for each item, merges results") { id } }`)
  const splitMergeId = splitMergeResult.createAction.id
  console.log(`  split-merge action id: ${splitMergeId}`)

  // Create 3 nodes: split, add_two, merge
  console.log('Building split-merge workflow definition...')
  const smNow = Date.now()

  const splitNode = {
    asset_type: 'pipeline_node',
    action: 'split',
    use_task_creator: false,
    timestamp: smNow,
  }
  const addTwoNode = {
    asset_type: 'pipeline_node',
    action: addTwoId,
    use_task_creator: false,
    timestamp: smNow + 10,
  }
  const mergeNode = {
    asset_type: 'pipeline_node',
    action: 'merge',
    use_task_creator: false,
    timestamp: smNow + 20,
  }

  const splitNodeId = await store(splitNode)
  const addTwoNodeId = await store(addTwoNode)
  const mergeNodeId = await store(mergeNode)
  console.log(`  split node CID: ${splitNodeId}`)
  console.log(`  add_two node CID: ${addTwoNodeId}`)
  console.log(`  merge node CID: ${mergeNodeId}`)

  // Create 9 edges for the split-merge workflow
  const smEdges = [
    // Pipeline input → split
    { asset_type: 'pipeline_edge', source: { node: null, name: 'items' }, target: { node: splitNodeId, name: 'input' } },
    // Split → add_two: tag edges for context propagation
    { asset_type: 'pipeline_edge', source: { node: splitNodeId, name: 'keys' }, target: { node: addTwoNodeId, name: '%keys' } },
    { asset_type: 'pipeline_edge', source: { node: splitNodeId, name: 'key' }, target: { node: addTwoNodeId, name: '%key' } },
    // Split → add_two: data edges (dot-path accessors)
    { asset_type: 'pipeline_edge', source: { node: splitNodeId, name: 'item.A' }, target: { node: addTwoNodeId, name: 'A' } },
    { asset_type: 'pipeline_edge', source: { node: splitNodeId, name: 'item.B' }, target: { node: addTwoNodeId, name: 'B' } },
    // add_two → merge: tag edges propagate context back as regular slots
    { asset_type: 'pipeline_edge', source: { node: addTwoNodeId, name: '%keys' }, target: { node: mergeNodeId, name: 'keys' } },
    { asset_type: 'pipeline_edge', source: { node: addTwoNodeId, name: '%key' }, target: { node: mergeNodeId, name: 'key' } },
    // add_two → merge: data edge
    { asset_type: 'pipeline_edge', source: { node: addTwoNodeId, name: 'output' }, target: { node: mergeNodeId, name: 'item' } },
    // Merge → pipeline output
    { asset_type: 'pipeline_edge', source: { node: mergeNodeId, name: 'output' }, target: { node: null, name: 'result' } },
  ]

  const smEdgeEntries = {}
  for (const edge of smEdges) {
    const edgeId = await store(edge)
    smEdgeEntries[edgeId] = edge
  }

  // Build the split-merge Pipeline object
  const smPipeline = {
    asset_type: 'action',
    timestamp: smNow,
    description: 'Split array, add A+B for each item, merge results',
    input_shape: { items: 'array' },
    output_shape: { result: 'array' },
    nodes: {
      [splitNodeId]: splitNode,
      [addTwoNodeId]: addTwoNode,
      [mergeNodeId]: mergeNode,
    },
    edges: smEdgeEntries,
  }

  // Store via GraphQL mutation
  console.log('Creating split-merge workflow definition version...')
  const smWfResult = await gql(
    `mutation($def: DictJSONAsset!) {
      createWorkflowDefinitionVersion(actionId: "${splitMergeId}", workflowDefinition: $def, commitMessage: "Initial split-merge workflow definition") {
        id
      }
    }`,
    { def: smPipeline }
  )
  console.log(`  split-merge workflow definition version: ${smWfResult.createWorkflowDefinitionVersion.id}`)

  // Gracefully stop the server so WAL is flushed
  console.log('Stopping server...')
  server.kill('SIGTERM')
  await new Promise((resolve) => {
    server.on('exit', resolve)
    setTimeout(resolve, 5000)
  })
  console.log('Server stopped.')

  // Create a clean DB copy via VACUUM INTO (self-contained, no WAL)
  const { execSync: exec } = await import('child_process')
  const cleanDb = outputDb + '.clean'
  try { unlinkSync(cleanDb) } catch {}
  exec(`sqlite3 "${outputDb}" "VACUUM INTO '${cleanDb}';"`)

  // Replace original with clean copy (no WAL/SHM needed)
  for (const ext of ['', '-wal', '-shm']) {
    try { unlinkSync(outputDb + ext) } catch {}
  }
  cpSync(cleanDb, outputDb)
  try { unlinkSync(cleanDb) } catch {}

  // Verify
  const tableCount = exec(`sqlite3 "${outputDb}" "SELECT count(*) FROM sqlite_master WHERE type='table';"`, { encoding: 'utf8' }).trim()
  console.log(`Tables in output DB: ${tableCount}`)

  console.log('\n=== Test Database Created ===')
  console.log(`  DB: ${outputDb}`)
  console.log(`  Add-Two Action ID: ${addTwoId}`)
  console.log(`  Add-Three Workflow Action ID: ${addThreeId}`)
  console.log(`  Node 1 (A+B) CID: ${node1Id}`)
  console.log(`  Node 2 (result+C) CID: ${node2Id}`)
  console.log(`  Split-Merge Workflow Action ID: ${splitMergeId}`)
  console.log(`  Split Node CID: ${splitNodeId}`)
  console.log(`  Add-Two Node CID: ${addTwoNodeId}`)
  console.log(`  Merge Node CID: ${mergeNodeId}`)
  console.log(`\nUpdate these files with the new action IDs:`)
  console.log(`  scripts/integration-test.sh  ACTION_ID="${addThreeId}"`)
  console.log(`  scripts/integration-test.sh  SPLIT_ACTION_ID="${splitMergeId}"`)
  console.log(`  pipeline-runner/src/index.ts  MONITORED_PIPELINES = ['${addThreeId}', '${splitMergeId}']`)
  console.log(`  typescript-worker/src/sample_add_two.ts  ACTION_ID = '${addTwoId}'`)

} catch (err) {
  console.error('Error:', err.message)
  console.error('Server log (last 30 lines):')
  console.error(serverLog.split('\n').slice(-30).join('\n'))
  process.exit(1)
} finally {
  cleanup()
}
