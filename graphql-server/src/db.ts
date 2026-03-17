// Copyright (c) 2026 Wuji Labs Inc
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import sqlite3 from 'sqlite3'

// Always use the database in ~/.playtiss directory (following asset.db pattern)
const getDefaultDbPath = () => {
  const playtissDir = path.join(homedir(), '.playtiss')
  // Ensure directory exists
  if (!fs.existsSync(playtissDir)) {
    fs.mkdirSync(playtissDir, { recursive: true })
  }
  return path.join(playtissDir, 'playtiss.db')
}

const DB_FILE = process.env.PLAYTISS_DB_PATH || getDefaultDbPath()

// Global DB instance for the application
let db: sqlite3.Database | null = null
let testDbInstance: sqlite3.Database | null = null

// For testing purposes: set the test DB instance
export function __setTestDBInstance(db: sqlite3.Database): void {
  testDbInstance = db
}

// For testing purposes: get the test DB instance
export function getTestDB(): sqlite3.Database | null {
  return testDbInstance
}

export function getDB(): sqlite3.Database {
  if (!db) {
    // Clean up any existing WAL files that might be causing locks
    try {
      const walFile = DB_FILE + '-wal'
      const shmFile = DB_FILE + '-shm'
      if (fs.existsSync(walFile)) {
        console.log('Removing existing WAL file:', walFile)
        fs.unlinkSync(walFile)
      }
      if (fs.existsSync(shmFile)) {
        console.log('Removing existing SHM file:', shmFile)
        fs.unlinkSync(shmFile)
      }
    }
    catch (cleanupErr) {
      console.log('WAL cleanup not needed or failed (normal):', cleanupErr)
    }

    db = new sqlite3.Database(DB_FILE, (err) => {
      if (err) {
        console.error('Error opening database', err)
        if (
          err.message?.includes('SQLITE_BUSY')
          || err.message?.includes('database is locked')
        ) {
          console.error(
            '┌─────────────────────────────────────────────────────────────┐',
          )
          console.error(
            '│ DATABASE LOCKED ERROR                                       │',
          )
          console.error(
            '│                                                             │',
          )
          console.error(
            '│ The database is being used by another application.         │',
          )
          console.error(
            '│ Please close any database browser tools (DB Browser,       │',
          )
          console.error(
            '│ SQLite tools, etc.) and try again.                         │',
          )
          console.error(
            '│                                                             │',
          )
          console.error(
            '│ You can check what\'s using the database with:              │',
          )
          console.error(
            '│ lsof +D /Users/cosimodw/metapipe/graphql-server/            │',
          )
          console.error(
            '└─────────────────────────────────────────────────────────────┘',
          )
        }
        throw err
      }
      console.log('Database opened successfully')

      // Configure SQLite for better concurrency using serialize() to ensure proper order
      db!.serialize(() => {
        // Set busy timeout first to handle any locks
        db!.run('PRAGMA busy_timeout = 30000', (err) => {
          if (err) console.error('Error setting busy timeout:', err)
        })

        // Try to enable WAL mode with fallback
        db!.run('PRAGMA journal_mode = WAL', (err) => {
          if (err) {
            console.warn(
              'Could not enable WAL mode, falling back to DELETE mode:',
              err,
            )
            db!.run('PRAGMA journal_mode = DELETE')
          }
          else {
            console.log('WAL mode enabled successfully')
          }
        })

        db!.run('PRAGMA synchronous = NORMAL')
        db!.run('PRAGMA cache_size = 10000')
        db!.run('PRAGMA temp_store = MEMORY')

        // Only set WAL-specific options if WAL mode succeeded
        db!.get('PRAGMA journal_mode', (err, row: any) => {
          if (!err && row && row.journal_mode === 'wal') {
            db!.run('PRAGMA wal_autocheckpoint = 1000')
            console.log('WAL-specific configuration applied')
          }
        })

        db!.run('PRAGMA max_page_count = 1073741823')

        console.log('SQLite configured for concurrency (30s timeout)')

        // Initialize database schema after configuration
        initializeDB()
      })
    })
  }
  return db
}

// Consolidated schema creation - final Phase 2 schema
// All tables created with their complete structure (no migrations needed)
function createSchema(
  dbInstance: sqlite3.Database,
  callback: (err?: Error) => void,
): void {
  dbInstance.serialize(() => {
    // =========================================================================
    // Table 1: Tasks
    // =========================================================================
    dbInstance.run(
      `
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
      `,
      (err) => {
        if (err) return callback(err)
        console.log('Tasks table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_tasks_list_by_creation ON Tasks (scope_id, action_id, task_id DESC);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_tasks_list_by_activity ON Tasks (scope_id, current_version_id DESC);`,
    )

    // =========================================================================
    // Table 2: Versions
    // =========================================================================
    dbInstance.run(
      `
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
      `,
      (err) => {
        if (err) return callback(err)
        console.log('Versions table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_versions_find_latest ON Versions (task_id, version_type_tag, version_id DESC);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_versions_find_by_parent ON Versions (parent_version_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_versions_find_by_definition ON Versions (executed_def_version_id);`,
    )

    // =========================================================================
    // Table 3: WorkflowRevisionNodeStates
    // Tracks node states within workflow revisions
    // Note: claim_* columns removed (migrated to TaskExecutionStates in v10)
    // =========================================================================
    dbInstance.run(
      `
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
          PRIMARY KEY (workflow_revision_id, node_id_in_workflow, context_asset_hash),
          FOREIGN KEY (workflow_revision_id) REFERENCES Versions(version_id),
          FOREIGN KEY (last_used_version_id) REFERENCES Versions(version_id)
        );
      `,
      (err) => {
        if (err) return callback(err)
        console.log('WorkflowRevisionNodeStates table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_revision_nodes_stale_check ON WorkflowRevisionNodeStates (workflow_revision_id, dependency_status);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_revision_nodes_runtime_check ON WorkflowRevisionNodeStates (workflow_revision_id, runtime_status);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_revision_nodes_find_by_output ON WorkflowRevisionNodeStates (last_used_version_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_task_id ON WorkflowRevisionNodeStates (required_task_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_task_workflow ON WorkflowRevisionNodeStates (required_task_id, workflow_revision_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_workflow_revision_node_states_node_lookup ON WorkflowRevisionNodeStates (workflow_revision_id, node_id_in_workflow, context_asset_hash);`,
    )

    // =========================================================================
    // Table 4: TaskExecutionStates
    // Real-time execution status tracking for task scheduling and worker coordination
    // =========================================================================
    dbInstance.run(
      `
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
      `,
      (err) => {
        if (err) return callback(err)
        console.log('TaskExecutionStates table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_task_execution_action_pending ON TaskExecutionStates (action_id, runtime_status, task_id) WHERE runtime_status = 'PENDING';`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_task_execution_action_expired ON TaskExecutionStates (action_id, runtime_status, expiration_time, task_id) WHERE runtime_status = 'RUNNING' AND expiration_time IS NOT NULL;`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_task_execution_global_pending ON TaskExecutionStates (runtime_status, task_id) WHERE runtime_status = 'PENDING';`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_task_execution_global_expired ON TaskExecutionStates (runtime_status, expiration_time, task_id) WHERE runtime_status = 'RUNNING' AND expiration_time IS NOT NULL;`,
    )

    // =========================================================================
    // Table 5: ExecutionHandles
    // Stable user-level identifiers for workflow execution instances
    // =========================================================================
    dbInstance.run(
      `
        CREATE TABLE IF NOT EXISTS ExecutionHandles (
          handle_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          description TEXT,
          FOREIGN KEY (task_id) REFERENCES Tasks(task_id)
        );
      `,
      (err) => {
        if (err) return callback(err)
        console.log('ExecutionHandles table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_handles_by_task ON ExecutionHandles (task_id);`,
    )

    // =========================================================================
    // Table 6: PipelineMergeAccumulator
    // Merge node state management for revision fork support
    // =========================================================================
    dbInstance.run(
      `
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
      `,
      (err) => {
        if (err) return callback(err)
        console.log('PipelineMergeAccumulator table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_merge_accumulator_workflow_revision ON PipelineMergeAccumulator(workflow_revision_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_merge_accumulator_pipeline ON PipelineMergeAccumulator(pipeline_id);`,
    )

    // =========================================================================
    // Table 7: InterceptorSessions
    // Tracks interceptor chat sessions for Phase 2 "Chat IS Workflow"
    // =========================================================================
    dbInstance.run(
      `
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
      `,
      (err) => {
        if (err) return callback(err)
        console.log('InterceptorSessions table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_interceptor_sessions_activity ON InterceptorSessions(last_activity DESC);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_interceptor_sessions_session_task ON InterceptorSessions(session_task_id);`,
    )

    // =========================================================================
    // Table 8: EventLog
    // Event bus for pub/sub architecture
    // =========================================================================
    dbInstance.run(
      `
        CREATE TABLE IF NOT EXISTS EventLog (
          event_id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          payload TEXT NOT NULL,
          timestamp_created INTEGER NOT NULL
        );
      `,
      (err) => {
        if (err) return callback(err)
        console.log('EventLog table created or already exists.')
      },
    )

    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_event_log_topic_id ON EventLog(topic, event_id);`,
    )
    dbInstance.run(
      `CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON EventLog(timestamp_created);`,
    )

    // =========================================================================
    // Table 9: ProjectionOffsets
    // Tracks event processing state for projections
    // =========================================================================
    dbInstance.run(
      `
        CREATE TABLE IF NOT EXISTS ProjectionOffsets (
          projection_id TEXT PRIMARY KEY,
          last_processed_event_id TEXT NOT NULL
        );
      `,
      (err) => {
        if (err) return callback(err)
        console.log('ProjectionOffsets table created or already exists.')
        // All tables created - signal completion
        callback()
      },
    )
  })
}

export async function initializeDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const mainDbInstance = getDB() // Ensures the main DB instance is used
    createSchema(mainDbInstance, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

// For testing purposes: connect to a specific DB (e.g., in-memory)
export function connectToDBForTesting(
  dbPath: string = ':memory:',
): Promise<sqlite3.Database> {
  return new Promise<sqlite3.Database>((resolve, reject) => {
    const testDb = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening test database', err)
        reject(err)
        return
      }
      console.log(`Test database opened successfully at ${dbPath}`)
      resolve(testDb)
    })
  })
}

// For testing purposes: initialize schema on a given DB instance
export async function initializeTestDB(
  dbInstance: sqlite3.Database,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    createSchema(dbInstance, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

/**
 * Gracefully shutdown the database with WAL checkpoint
 * This ensures all data is written to the main database file before closing
 */
export async function shutdownDB(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!db) {
      console.log('Database not initialized, nothing to shutdown')
      resolve()
      return
    }

    console.log('Performing WAL checkpoint before shutdown...')

    // Force WAL checkpoint to persist all changes
    db.run('PRAGMA wal_checkpoint(FULL)', (checkpointErr) => {
      if (checkpointErr) {
        console.warn(
          'WAL checkpoint warning (may be normal):',
          checkpointErr.message,
        )
      }
      else {
        console.log('WAL checkpoint completed successfully')
      }

      // Close the database connection
      db!.close((closeErr) => {
        if (closeErr) {
          console.error('Error closing database:', closeErr.message)
          reject(closeErr)
        }
        else {
          console.log('Database closed successfully')
          db = null
          resolve()
        }
      })
    })
  })
}

/**
 * Periodic WAL checkpoint to prevent excessive WAL file growth
 * This runs every 30 seconds to ensure data is flushed regularly
 */
function startPeriodicCheckpoint(): void {
  const CHECKPOINT_INTERVAL = 30 * 1000 // 30 seconds

  setInterval(() => {
    if (db) {
      db.run('PRAGMA wal_checkpoint(PASSIVE)', (err) => {
        if (err) {
          console.warn('Periodic WAL checkpoint warning:', err.message)
        }
        else {
          console.log('Periodic WAL checkpoint completed')
        }
      })
    }
  }, CHECKPOINT_INTERVAL)
}

// Initialize the main database when the module is loaded
getDB()
startPeriodicCheckpoint()
