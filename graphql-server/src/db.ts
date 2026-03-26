// Copyright (c) 2026 Wuji Labs Inc
import type { Database as DatabaseType } from 'better-sqlite3'
import Database from 'better-sqlite3'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'

const getDefaultDbPath = () => {
  const playtissDir = path.join(homedir(), '.playtiss')
  if (!fs.existsSync(playtissDir)) {
    fs.mkdirSync(playtissDir, { recursive: true })
  }
  return path.join(playtissDir, 'playtiss.db')
}

const DB_FILE = process.env.PLAYTISS_DB_PATH || getDefaultDbPath()

let db: DatabaseType | null = null
let testDbInstance: DatabaseType | null = null

export function __setTestDBInstance(instance: DatabaseType): void {
  testDbInstance = instance
}

export function getTestDB(): DatabaseType | null {
  return testDbInstance
}

export function getDB(): DatabaseType {
  if (!db) {
    db = new Database(DB_FILE, { timeout: 30000 })
    console.log('Database opened successfully')

    // Configure SQLite for better concurrency
    // Disable foreign keys to match legacy sqlite3 behavior (was never enforced)
    db.pragma('foreign_keys = OFF')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = 10000')
    db.pragma('temp_store = MEMORY')
    db.pragma('wal_autocheckpoint = 1000')
    db.pragma('max_page_count = 1073741823')
    console.log('SQLite configured (WAL mode, 30s timeout)')

    initializeDB(db)
  }
  return db
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS Tasks (
    task_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    inputs_content_hash TEXT,
    name TEXT,
    description TEXT,
    current_version_id TEXT,
    active_revision_id TEXT,
    timestamp_created INTEGER NOT NULL,
    UNIQUE (scope_id, action_id, inputs_content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_list_by_creation ON Tasks (scope_id, action_id, task_id DESC);
  CREATE INDEX IF NOT EXISTS idx_tasks_list_by_activity ON Tasks (scope_id, current_version_id DESC);

  CREATE TABLE IF NOT EXISTS Versions (
    version_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    version_type_tag TEXT NOT NULL,
    asset_content_hash TEXT,
    parent_version_id TEXT,
    timestamp_created INTEGER NOT NULL,
    user_given_tag TEXT,
    commit_message TEXT,
    executed_def_version_id TEXT,
    FOREIGN KEY (task_id) REFERENCES Tasks(task_id),
    FOREIGN KEY (parent_version_id) REFERENCES Versions(version_id),
    FOREIGN KEY (executed_def_version_id) REFERENCES Versions(version_id)
  );
  CREATE INDEX IF NOT EXISTS idx_versions_find_latest ON Versions (task_id, version_type_tag, version_id DESC);
  CREATE INDEX IF NOT EXISTS idx_versions_find_by_parent ON Versions (parent_version_id);
  CREATE INDEX IF NOT EXISTS idx_versions_find_by_definition ON Versions (executed_def_version_id);

  CREATE TABLE IF NOT EXISTS WorkflowRevisionNodeStates (
    workflow_revision_id TEXT NOT NULL,
    node_id_in_workflow TEXT NOT NULL,
    context_asset_hash TEXT NOT NULL,
    last_used_version_id TEXT,
    last_inputs_hash TEXT,
    dependency_status TEXT NOT NULL,
    runtime_status TEXT NOT NULL,
    error_message TEXT,
    required_task_id TEXT,
    meta_asset_hash TEXT,
    PRIMARY KEY (workflow_revision_id, node_id_in_workflow, context_asset_hash),
    FOREIGN KEY (workflow_revision_id) REFERENCES Versions(version_id),
    FOREIGN KEY (last_used_version_id) REFERENCES Versions(version_id)
  );
  CREATE INDEX IF NOT EXISTS idx_revision_nodes_stale_check ON WorkflowRevisionNodeStates (workflow_revision_id, dependency_status);
  CREATE INDEX IF NOT EXISTS idx_revision_nodes_runtime_check ON WorkflowRevisionNodeStates (workflow_revision_id, runtime_status);
  CREATE INDEX IF NOT EXISTS idx_revision_nodes_find_by_output ON WorkflowRevisionNodeStates (last_used_version_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_task_id ON WorkflowRevisionNodeStates (required_task_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_task_workflow ON WorkflowRevisionNodeStates (required_task_id, workflow_revision_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_node_lookup ON WorkflowRevisionNodeStates (workflow_revision_id, node_id_in_workflow, context_asset_hash);

  CREATE TABLE IF NOT EXISTS TaskExecutionStates (
    task_id TEXT PRIMARY KEY,
    action_id TEXT,
    runtime_status TEXT NOT NULL,
    claim_timestamp INTEGER,
    claim_worker_id TEXT,
    claim_ttl_seconds INTEGER,
    expiration_time INTEGER,
    FOREIGN KEY (task_id) REFERENCES Tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_execution_action_pending ON TaskExecutionStates (action_id, runtime_status, task_id) WHERE runtime_status = 'PENDING';
  CREATE INDEX IF NOT EXISTS idx_task_execution_action_expired ON TaskExecutionStates (action_id, runtime_status, expiration_time, task_id) WHERE runtime_status = 'RUNNING' AND expiration_time IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_task_execution_global_pending ON TaskExecutionStates (runtime_status, task_id) WHERE runtime_status = 'PENDING';
  CREATE INDEX IF NOT EXISTS idx_task_execution_global_expired ON TaskExecutionStates (runtime_status, expiration_time, task_id) WHERE runtime_status = 'RUNNING' AND expiration_time IS NOT NULL;

  CREATE TABLE IF NOT EXISTS ExecutionHandles (
    handle_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    description TEXT,
    FOREIGN KEY (task_id) REFERENCES Tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_handles_by_task ON ExecutionHandles (task_id);

  CREATE TABLE IF NOT EXISTS PipelineMergeAccumulator (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id TEXT NOT NULL,
    workflow_revision_id TEXT NOT NULL,
    context_asset_hash TEXT NOT NULL,
    node_id TEXT NOT NULL,
    accumulator_json TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(pipeline_id, workflow_revision_id, context_asset_hash, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_merge_accumulator_workflow_revision ON PipelineMergeAccumulator(workflow_revision_id);
  CREATE INDEX IF NOT EXISTS idx_merge_accumulator_pipeline ON PipelineMergeAccumulator(pipeline_id);

  CREATE TABLE IF NOT EXISTS InterceptorSessions (
    session_id TEXT PRIMARY KEY,
    session_task_id TEXT NOT NULL,
    computation_task_id TEXT NOT NULL,
    current_revision_id TEXT NOT NULL,
    reference_context_json TEXT,
    tool_call_mapping_json TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    FOREIGN KEY (session_task_id) REFERENCES Tasks(task_id),
    FOREIGN KEY (computation_task_id) REFERENCES Tasks(task_id),
    FOREIGN KEY (current_revision_id) REFERENCES Versions(version_id)
  );
  CREATE INDEX IF NOT EXISTS idx_interceptor_sessions_activity ON InterceptorSessions(last_activity DESC);
  CREATE INDEX IF NOT EXISTS idx_interceptor_sessions_session_task ON InterceptorSessions(session_task_id);

  CREATE TABLE IF NOT EXISTS EventLog (
    event_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp_created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_log_topic_id ON EventLog(topic, event_id);
  CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON EventLog(timestamp_created);

  CREATE TABLE IF NOT EXISTS ProjectionOffsets (
    projection_id TEXT PRIMARY KEY,
    last_processed_event_id TEXT NOT NULL
  );
`

function initializeDB(dbInstance: DatabaseType): void {
  dbInstance.exec(SCHEMA_SQL)
  console.log('Database schema initialized')
}

export function connectToDBForTesting(dbPath: string = ':memory:'): DatabaseType {
  const testDb = new Database(dbPath)
  console.log(`Test database opened successfully at ${dbPath}`)
  return testDb
}

export function initializeTestDB(dbInstance: DatabaseType): void {
  initializeDB(dbInstance)
}

export function shutdownDB(): void {
  if (!db) {
    console.log('Database not initialized, nothing to shutdown')
    return
  }

  console.log('Performing WAL checkpoint before shutdown...')
  try {
    db.pragma('wal_checkpoint(FULL)')
    console.log('WAL checkpoint completed successfully')
  }
  catch (err: any) {
    console.warn('WAL checkpoint warning (may be normal):', err.message)
  }

  db.close()
  console.log('Database closed successfully')
  db = null
}

function startPeriodicCheckpoint(): void {
  const CHECKPOINT_INTERVAL = 30 * 1000

  setInterval(() => {
    if (db) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)')
      }
      catch (err: any) {
        console.warn('Periodic WAL checkpoint warning:', err.message)
      }
    }
  }, CHECKPOINT_INTERVAL)
}

// Initialize the main database when the module is loaded
getDB()
startPeriodicCheckpoint()
