#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: List Entities
 *
 * Lists tasks, versions, or workflow runs from the SQLite database.
 * Usage: tsx dev-tools/list-entities.ts <entity-type> [limit]
 */

import dotenv from "dotenv";

// Load environment configuration from local .env file
dotenv.config();

import fs from "fs";
import { homedir } from "os";
import path from "path";
import sqlite3 from "sqlite3";

// Helper function to get default DB path in ~/.playtiss
const getDefaultDbPath = () => {
  const playtissDir = path.join(homedir(), ".playtiss");
  // Ensure directory exists
  if (!fs.existsSync(playtissDir)) {
    fs.mkdirSync(playtissDir, { recursive: true });
  }
  return path.join(playtissDir, "playtiss.db");
};

interface TaskRow {
  task_id: string;
  scope_id: string;
  action_id: string;
  name: string | null;
  description: string | null;
  current_version_id: string | null;
  timestamp_created: number;
}

interface VersionRow {
  version_id: string;
  task_id: string;
  version_type_tag: string;
  asset_content_hash: string | null;
  parent_version_id: string | null;
  timestamp_created: number;
  user_given_tag: string | null;
  commit_message: string | null;
  executed_def_version_id: string | null;
}

interface WorkflowRunRow {
  workflow_run_id: string;
  node_id_in_workflow: string;
  context_asset_hash: string;
  last_used_version_id: string | null;
  last_inputs_hash: string | null;
  dependency_status: string;
  runtime_status: string;
  error_message: string | null;
  claim_timestamp: number | null;
  claim_worker_id: string | null;
  claim_ttl_seconds: number | null;
}

interface TaskExecutionStateRow {
  task_id: string;
  runtime_status: string;
  claim_timestamp: number | null;
  claim_worker_id: string | null;
  claim_ttl_seconds: number | null;
  action_id: string | null;
  expiration_time: number | null;
}

async function listTasks(limit: number = 20) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  console.log(`🔍 Using database: ${dbPath}`);

  return new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error(`❌ Error opening database: ${err.message}`);
        reject(err);
        return;
      }

      console.log(`📋 Recent Tasks (limit: ${limit})`);
      console.log("━".repeat(80));

      listTasksFromDB(db, limit).then(resolve).catch(reject);
    });
  });
}

async function listTasksFromDB(db: sqlite3.Database, limit: number) {
  try {
    const tasks = await new Promise<TaskRow[]>((resolve, reject) => {
      db.all(
        "SELECT * FROM Tasks ORDER BY timestamp_created DESC LIMIT ?",
        [limit],
        (err, rows: TaskRow[]) => {
          if (err) {
            console.error(`❌ Database query error: ${err.message}`);
            reject(err);
          } else {
            console.log(`🔍 Found ${rows?.length || 0} tasks`);
            resolve(rows || []);
          }
        }
      );
    });

    if (tasks.length === 0) {
      console.log("No tasks found.");
      return;
    }

    console.log(
      `${"Task ID".padEnd(40)} ${"Name".padEnd(25)} ${"Action ID".padEnd(40)} ${"Created".padEnd(20)}`
    );
    console.log("─".repeat(80));

    for (const task of tasks) {
      const taskId = task.task_id.padEnd(40);
      const name = (task.name || "(unnamed)").slice(0, 24).padEnd(25);
      const actionId = task.action_id.slice(0, 39).padEnd(40);
      const created = new Date(task.timestamp_created)
        .toISOString()
        .slice(0, 19)
        .padEnd(20);

      console.log(`${taskId} ${name} ${actionId} ${created}`);

      if (task.description) {
        console.log(`  📝 ${task.description}`);
      }
      if (task.current_version_id) {
        console.log(`  📄 Current: ${task.current_version_id}`);
      }
      console.log();
    }
  } catch (error: any) {
    console.error(`❌ Error listing tasks: ${error.message}`);
    throw error;
  } finally {
    db.close();
  }
}

async function listVersions(limit: number = 20) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`📄 Recent Versions (limit: ${limit})`);
    console.log("━".repeat(100));

    const versions = await new Promise<VersionRow[]>((resolve, reject) => {
      db.all(
        "SELECT * FROM Versions ORDER BY timestamp_created DESC LIMIT ?",
        [limit],
        (err, rows: VersionRow[]) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (versions.length === 0) {
      console.log("No versions found.");
      return;
    }

    console.log(
      `${"Version ID".padEnd(40)} ${"Type".padEnd(20)} ${"Task ID".padEnd(40)} ${"Created".padEnd(20)}`
    );
    console.log("─".repeat(100));

    for (const version of versions) {
      const versionId = version.version_id.padEnd(40);
      const type = version.version_type_tag.padEnd(20);
      const taskId = version.task_id.slice(0, 39).padEnd(40);
      const created = new Date(version.timestamp_created)
        .toISOString()
        .slice(0, 19)
        .padEnd(20);

      console.log(`${versionId} ${type} ${taskId} ${created}`);

      if (version.user_given_tag) {
        console.log(`  🏷️  Tag: ${version.user_given_tag}`);
      }
      if (version.commit_message) {
        console.log(`  💬 ${version.commit_message}`);
      }
      if (version.asset_content_hash) {
        console.log(`  📦 Asset: ${version.asset_content_hash}`);
      }
      console.log();
    }
  } catch (error: any) {
    console.error(`❌ Error listing versions: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function listWorkflowRuns(limit: number = 10) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`🚀 Recent Workflow Runs (limit: ${limit} runs)`);
    console.log("━".repeat(120));

    // Get unique workflow runs first
    const workflowRuns = await new Promise<{ workflow_run_id: string }[]>(
      (resolve, reject) => {
        db.all(
          "SELECT DISTINCT workflow_run_id FROM WorkflowRunNodeStates ORDER BY workflow_run_id DESC LIMIT ?",
          [limit],
          (err, rows: { workflow_run_id: string }[]) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      }
    );

    if (workflowRuns.length === 0) {
      console.log("No workflow runs found.");
      return;
    }

    for (const run of workflowRuns) {
      console.log(`🚀 Workflow Run: ${run.workflow_run_id}`);
      console.log("─".repeat(60));

      // Get all nodes for this workflow run
      const nodes = await new Promise<WorkflowRunRow[]>((resolve, reject) => {
        db.all(
          "SELECT * FROM WorkflowRunNodeStates WHERE workflow_run_id = ? ORDER BY node_id_in_workflow",
          [run.workflow_run_id],
          (err, rows: WorkflowRunRow[]) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      console.log(
        `${"Node ID".padEnd(15)} ${"Dependency".padEnd(12)} ${"Runtime".padEnd(15)} ${"Worker".padEnd(20)} ${"Version".padEnd(40)}`
      );
      console.log("─".repeat(60));

      for (const node of nodes) {
        const nodeId = node.node_id_in_workflow.padEnd(15);
        const depStatus = node.dependency_status.padEnd(12);
        const runtimeStatus = node.runtime_status.padEnd(15);
        const worker = (node.claim_worker_id || "-").slice(0, 19).padEnd(20);
        const version = (node.last_used_version_id || "-")
          .slice(0, 39)
          .padEnd(40);

        console.log(
          `${nodeId} ${depStatus} ${runtimeStatus} ${worker} ${version}`
        );

        if (node.error_message) {
          console.log(`  ❌ Error: ${node.error_message}`);
        }
        if (node.claim_timestamp) {
          console.log(
            `  ⏰ Claimed: ${new Date(node.claim_timestamp).toISOString()}`
          );
        }
      }
      console.log();
    }
  } catch (error: any) {
    console.error(`❌ Error listing workflow runs: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function listTaskExecutionStates(limit: number = 20) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`⚡ Recent Task Execution States (limit: ${limit})`);
    console.log("━".repeat(120));

    const states = await new Promise<TaskExecutionStateRow[]>(
      (resolve, reject) => {
        db.all(
          "SELECT * FROM TaskExecutionStates ORDER BY task_id DESC LIMIT ?",
          [limit],
          (err, rows: TaskExecutionStateRow[]) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      }
    );

    if (states.length === 0) {
      console.log("No task execution states found.");
      return;
    }

    console.log(
      `${"Task ID".padEnd(40)} ${"Status".padEnd(12)} ${"Action ID".padEnd(40)} ${"Worker".padEnd(20)} ${"Expiration".padEnd(20)}`
    );
    console.log("─".repeat(120));

    const currentTime = Date.now();

    for (const state of states) {
      const taskId = state.task_id.padEnd(40);
      const status = state.runtime_status.padEnd(12);
      const actionId = (state.action_id || "-").slice(0, 39).padEnd(40);
      const worker = (state.claim_worker_id || "-").slice(0, 19).padEnd(20);

      let expiration = "-".padEnd(20);
      if (state.expiration_time) {
        const expired = currentTime > state.expiration_time;
        const expTime = new Date(state.expiration_time)
          .toISOString()
          .slice(11, 19);
        expiration = `${expTime}${expired ? " ⚠️" : ""}`.padEnd(20);
      }

      console.log(`${taskId} ${status} ${actionId} ${worker} ${expiration}`);

      if (state.claim_timestamp) {
        console.log(
          `  ⏰ Claimed: ${new Date(state.claim_timestamp).toISOString()}`
        );
      }
      console.log();
    }
  } catch (error: any) {
    console.error(`❌ Error listing task execution states: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function showStats() {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`📊 Database Statistics`);
    console.log("━".repeat(40));

    // Count tasks
    const taskCount = await new Promise<number>((resolve, reject) => {
      db.get(
        "SELECT COUNT(*) as count FROM Tasks",
        (err, row: { count: number }) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    // Count versions by type
    const versionStats = await new Promise<
      { version_type_tag: string; count: number }[]
    >((resolve, reject) => {
      db.all(
        "SELECT version_type_tag, COUNT(*) as count FROM Versions GROUP BY version_type_tag ORDER BY count DESC",
        (err, rows: { version_type_tag: string; count: number }[]) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Count workflow runs
    const workflowRunCount = await new Promise<number>((resolve, reject) => {
      db.get(
        "SELECT COUNT(DISTINCT workflow_run_id) as count FROM WorkflowRunNodeStates",
        (err, row: { count: number }) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    // Count task execution states by status
    const executionStats = await new Promise<
      { runtime_status: string; count: number }[]
    >((resolve, reject) => {
      db.all(
        "SELECT runtime_status, COUNT(*) as count FROM TaskExecutionStates GROUP BY runtime_status ORDER BY count DESC",
        (err, rows: { runtime_status: string; count: number }[]) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Count expired claims
    const currentTime = Date.now();
    const expiredCount = await new Promise<number>((resolve, reject) => {
      db.get(
        'SELECT COUNT(*) as count FROM TaskExecutionStates WHERE runtime_status = "RUNNING" AND expiration_time IS NOT NULL AND ? > expiration_time',
        [currentTime],
        (err, row: { count: number }) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    console.log(`📋 Tasks: ${taskCount}`);
    console.log(`🚀 Workflow Runs: ${workflowRunCount}`);
    console.log(`📄 Versions:`);

    for (const stat of versionStats) {
      console.log(`   ${stat.version_type_tag}: ${stat.count}`);
    }

    console.log(`⚡ Task Execution States:`);
    for (const stat of executionStats) {
      console.log(`   ${stat.runtime_status}: ${stat.count}`);
    }

    if (expiredCount > 0) {
      console.log(`⚠️  Expired Claims: ${expiredCount}`);
    }

    console.log();
  } catch (error: any) {
    console.error(`❌ Error getting stats: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const entityType = process.argv[2];
  const limit = parseInt(process.argv[3] || "20");

  if (!entityType) {
    console.error(
      "Usage: tsx dev-tools/list-entities.ts <entity-type> [limit]"
    );
    console.error("");
    console.error("Entity types:");
    console.error("  tasks       - List recent tasks");
    console.error("  versions    - List recent versions");
    console.error("  runs        - List recent workflow runs");
    console.error("  states      - List task execution states");
    console.error("  stats       - Show database statistics");
    console.error("");
    console.error("Examples:");
    console.error("  tsx dev-tools/list-entities.ts tasks 10");
    console.error("  tsx dev-tools/list-entities.ts versions 20");
    console.error("  tsx dev-tools/list-entities.ts runs 5");
    console.error("  tsx dev-tools/list-entities.ts states 15");
    console.error("  tsx dev-tools/list-entities.ts stats");
    process.exit(1);
  }

  switch (entityType.toLowerCase()) {
    case "tasks":
      listTasks(limit);
      break;
    case "versions":
      listVersions(limit);
      break;
    case "runs":
    case "workflows":
      listWorkflowRuns(limit);
      break;
    case "states":
    case "execution":
      listTaskExecutionStates(limit);
      break;
    case "stats":
      showStats();
      break;
    default:
      console.error(`Unknown entity type: ${entityType}`);
      console.error("Valid types: tasks, versions, runs, states, stats");
      process.exit(1);
  }
}
