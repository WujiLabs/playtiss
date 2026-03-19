#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: Inspect Version
 *
 * Loads and displays a version directly from the SQLite database.
 * Usage: tsx dev-tools/inspect-version.ts <version-id>
 */

import dotenv from "dotenv";

// Load environment configuration from local .env file
dotenv.config();

import fs from "fs";
import { homedir } from "os";
import path from "path";
import { isAssetId } from "playtiss";
import { load } from "playtiss/asset-store";
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

interface TaskRow {
  task_id: string;
  scope_id: string;
  action_id: string;
  name: string | null;
  description: string | null;
  current_version_id: string | null;
  timestamp_created: number;
}

async function inspectVersion(versionId: string) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`🔍 Inspecting Version: ${versionId}`);
    console.log("━".repeat(60));

    // Get version information
    const version = await new Promise<VersionRow | null>((resolve, reject) => {
      db.get(
        "SELECT * FROM Versions WHERE version_id = ?",
        [versionId],
        (err, row: VersionRow) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });

    if (!version) {
      throw new Error(`Version not found: ${versionId}`);
    }

    // Get associated task information
    const task = await new Promise<TaskRow | null>((resolve, reject) => {
      db.get(
        "SELECT * FROM Tasks WHERE task_id = ?",
        [version.task_id],
        (err, row: TaskRow) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });

    // Display version information
    console.log(`📄 Version Information:`);
    console.log(`   ID: ${version.version_id}`);
    console.log(`   Type: ${version.version_type_tag}`);
    console.log(
      `   Created: ${new Date(version.timestamp_created).toISOString()}`
    );
    console.log(`   Task ID: ${version.task_id}`);
    if (version.user_given_tag)
      console.log(`   User Tag: ${version.user_given_tag}`);
    if (version.commit_message)
      console.log(`   Commit Message: ${version.commit_message}`);
    console.log();

    // Display task context
    if (task) {
      console.log(`📋 Associated Task:`);
      console.log(`   Name: ${task.name || "(none)"}`);
      console.log(`   Description: ${task.description || "(none)"}`);
      console.log(`   Action ID: ${task.action_id}`);
      console.log(`   Scope: ${task.scope_id}`);
      const isCurrent = task.current_version_id === versionId;
      console.log(`   Current Version: ${isCurrent ? "✓ Yes" : "✗ No"}`);
      console.log();
    }

    // Display relationships
    console.log(`🔗 Relationships:`);
    if (version.parent_version_id) {
      console.log(`   Parent Version: ${version.parent_version_id}`);
    }
    if (version.executed_def_version_id) {
      console.log(`   Executed Definition: ${version.executed_def_version_id}`);
    }
    if (version.asset_content_hash) {
      console.log(`   Asset Hash: ${version.asset_content_hash}`);
    } else {
      console.log(`   Asset Hash: (none)`);
    }
    console.log();

    // Get child versions
    const childVersions = await new Promise<VersionRow[]>((resolve, reject) => {
      db.all(
        "SELECT * FROM Versions WHERE parent_version_id = ? ORDER BY timestamp_created DESC",
        [versionId],
        (err, rows: VersionRow[]) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (childVersions.length > 0) {
      console.log(`👶 Child Versions (${childVersions.length}):`);
      for (const child of childVersions) {
        console.log(`   • ${child.version_id} (${child.version_type_tag})`);
        console.log(
          `     Created: ${new Date(child.timestamp_created).toISOString()}`
        );
      }
      console.log();
    }

    // Get executions of this definition (if it's a workflow_definition)
    if (version.version_type_tag === "workflow_definition") {
      const executions = await new Promise<VersionRow[]>((resolve, reject) => {
        db.all(
          "SELECT * FROM Versions WHERE executed_def_version_id = ? ORDER BY timestamp_created DESC",
          [versionId],
          (err, rows: VersionRow[]) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      if (executions.length > 0) {
        console.log(`🚀 Executions (${executions.length}):`);
        for (const execution of executions) {
          console.log(
            `   • ${execution.version_id} (${execution.version_type_tag})`
          );
          console.log(
            `     Created: ${new Date(execution.timestamp_created).toISOString()}`
          );
        }
        console.log();
      }
    }

    // Display asset content if available
    if (version.asset_content_hash) {
      await displayAssetContent(
        version.version_type_tag,
        version.asset_content_hash
      );
    }
  } catch (error: any) {
    console.error(`❌ Error inspecting version: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function displayAssetContent(versionType: string, assetId: string) {
  try {
    console.log(`📦 Asset Content (${versionType}):`);
    console.log("─".repeat(40));

    if (!isAssetId(assetId)) {
      console.log(`❌ Invalid asset ID format: ${assetId}`);
      console.log();
      return;
    }

    const data = await load(assetId);
    const content = JSON.stringify(data, null, 2);

    // For workflow definitions, format nicely
    if (versionType === "workflow_definition") {
      console.log("🔧 Workflow Definition:");
      console.log(content);
    } else {
      console.log(content);
    }

    console.log();
  } catch (error: any) {
    console.log(`⚠️ Could not load asset: ${error.message}`);
    console.log();
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const versionId = process.argv[2];

  if (!versionId) {
    console.error("Usage: tsx dev-tools/inspect-version.ts <version-id>");
    console.error("");
    console.error("Example:");
    console.error(
      "  tsx dev-tools/inspect-version.ts 01977abe-dd67-89b6-8153-24d397000001"
    );
    process.exit(1);
  }

  inspectVersion(versionId);
}
