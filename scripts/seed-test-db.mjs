#!/usr/bin/env node
/**
 * Creates the test database for integration testing.
 * Starts graphql-server, creates workflow via GraphQL, saves the DB.
 */
import { spawn } from 'child_process'
import { cpSync, unlinkSync } from 'fs'
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
    }
    catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw new Error('Server did not start in time')
}

// Import generateTraceId for node/edge keys
const { generateTraceId } = await import('../playtiss-core/dist/trace-id.js')

// Setup — write directly to the output path to avoid WAL copy issues
const outputDb = join(PROJECT_ROOT, 'graphql-server', 'playtiss-test-add3.db')
// Remove stale DB files
for (const ext of ['', '-wal', '-shm']) {
  try {
    unlinkSync(outputDb + ext)
  }
  catch {
    // ignore if path does not exist
  }
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

const cleanup = () => {
  try {
    server.kill()
  }
  catch {
    // ignore if already exited
  }
}
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

  // Build proper Pipeline structure with TraceId-keyed nodes and edges
  console.log('Building workflow definition...')

  // Create Node objects with TraceId keys
  const node1 = { action: addTwoId }
  const node2 = { action: addTwoId }
  const node1Id = generateTraceId()
  const node2Id = generateTraceId()
  console.log(`  node1 (add A+B) ID: ${node1Id}`)
  console.log(`  node2 (add result+C) ID: ${node2Id}`)

  // Create Edge objects with TraceId keys (flat ReactFlow-style shape, v0.5.0+)
  const edges = [
    { source: null, sourceHandle: 'A', target: node1Id, targetHandle: 'A' },
    { source: null, sourceHandle: 'B', target: node1Id, targetHandle: 'B' },
    { source: node1Id, sourceHandle: 'output', target: node2Id, targetHandle: 'A' },
    { source: null, sourceHandle: 'C', target: node2Id, targetHandle: 'B' },
    { source: node2Id, sourceHandle: 'output', target: null, targetHandle: 'result' },
  ]
  const edgeEntries = {}
  for (const edge of edges) {
    const edgeId = generateTraceId()
    edgeEntries[edgeId] = edge
  }

  // Build the Pipeline object
  const pipeline = {
    description: 'Add three numbers: (A+B)+C',
    input_schema: {
      type: 'object',
      properties: {
        A: { type: 'number' },
        B: { type: 'number' },
        C: { type: 'number' },
      },
      required: ['A', 'B', 'C'],
    },
    output_schema: {
      type: 'object',
      properties: {
        result: { type: 'number' },
      },
      required: ['result'],
    },
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
    { def: pipeline },
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

  const splitNode = { action: 'split' }
  const addTwoNode = { action: addTwoId }
  const mergeNode = { action: 'merge' }

  const splitNodeId = generateTraceId()
  const addTwoNodeId = generateTraceId()
  const mergeNodeId = generateTraceId()
  console.log(`  split node ID: ${splitNodeId}`)
  console.log(`  add_two node ID: ${addTwoNodeId}`)
  console.log(`  merge node ID: ${mergeNodeId}`)

  // Create 9 edges for the split-merge workflow (flat ReactFlow-style shape, v0.5.0+)
  const smEdges = [
    // Pipeline input → split
    { source: null, sourceHandle: 'items', target: splitNodeId, targetHandle: 'input' },
    // Split → add_two: tag edges for context propagation
    { source: splitNodeId, sourceHandle: 'keys', target: addTwoNodeId, targetHandle: '%keys' },
    { source: splitNodeId, sourceHandle: 'key', target: addTwoNodeId, targetHandle: '%key' },
    // Split → add_two: data edges (dot-path accessors)
    { source: splitNodeId, sourceHandle: 'item.A', target: addTwoNodeId, targetHandle: 'A' },
    { source: splitNodeId, sourceHandle: 'item.B', target: addTwoNodeId, targetHandle: 'B' },
    // add_two → merge: tag edges propagate context back as regular slots
    { source: addTwoNodeId, sourceHandle: '%keys', target: mergeNodeId, targetHandle: 'keys' },
    { source: addTwoNodeId, sourceHandle: '%key', target: mergeNodeId, targetHandle: 'key' },
    // add_two → merge: data edge
    { source: addTwoNodeId, sourceHandle: 'output', target: mergeNodeId, targetHandle: 'item' },
    // Merge → pipeline output
    { source: mergeNodeId, sourceHandle: 'output', target: null, targetHandle: 'result' },
  ]

  const smEdgeEntries = {}
  for (const edge of smEdges) {
    const edgeId = generateTraceId()
    smEdgeEntries[edgeId] = edge
  }

  // Build the split-merge Pipeline object
  const smPipeline = {
    description: 'Split array, add A+B for each item, merge results',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array' },
      },
      required: ['items'],
    },
    output_schema: {
      type: 'object',
      properties: {
        result: { type: 'array' },
      },
      required: ['result'],
    },
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
    { def: smPipeline },
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
  try {
    unlinkSync(cleanDb)
  }
  catch {
    // ignore if path does not exist
  }
  exec(`sqlite3 "${outputDb}" "VACUUM INTO '${cleanDb}';"`)

  // Replace original with clean copy (no WAL/SHM needed)
  for (const ext of ['', '-wal', '-shm']) {
    try {
      unlinkSync(outputDb + ext)
    }
    catch {
      // ignore if path does not exist
    }
  }
  cpSync(cleanDb, outputDb)
  try {
    unlinkSync(cleanDb)
  }
  catch {
    // ignore if path does not exist
  }

  // Verify
  const tableCount = exec(`sqlite3 "${outputDb}" "SELECT count(*) FROM sqlite_master WHERE type='table';"`, { encoding: 'utf8' }).trim()
  console.log(`Tables in output DB: ${tableCount}`)

  console.log('\n=== Test Database Created ===')
  console.log(`  DB: ${outputDb}`)
  console.log(`  Add-Two Action ID: ${addTwoId}`)
  console.log(`  Add-Three Workflow Action ID: ${addThreeId}`)
  console.log(`  Node 1 (A+B) ID: ${node1Id}`)
  console.log(`  Node 2 (result+C) ID: ${node2Id}`)
  console.log(`  Split-Merge Workflow Action ID: ${splitMergeId}`)
  console.log(`  Split Node ID: ${splitNodeId}`)
  console.log(`  Add-Two Node ID: ${addTwoNodeId}`)
  console.log(`  Merge Node ID: ${mergeNodeId}`)
  console.log(`\nUpdate these files with the new action IDs:`)
  console.log(`  scripts/integration-test.sh  ACTION_ID="${addThreeId}"`)
  console.log(`  scripts/integration-test.sh  SPLIT_ACTION_ID="${splitMergeId}"`)
  console.log(`  pipeline-runner/src/index.ts  MONITORED_PIPELINES = ['${addThreeId}', '${splitMergeId}']`)
  console.log(`  typescript-worker/src/sample_add_two.ts  ACTION_ID = '${addTwoId}'`)
}
catch (err) {
  console.error('Error:', err.message)
  console.error('Server log (last 30 lines):')
  console.error(serverLog.split('\n').slice(-30).join('\n'))
  process.exit(1)
}
finally {
  cleanup()
}
