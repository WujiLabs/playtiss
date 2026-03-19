#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: Inspect Task
 *
 * Loads and displays a task directly from the SQLite database.
 * Usage: tsx dev-tools/inspect-task.ts <task-id>
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

interface TaskRow {
  task_id: string;
  scope_id: string;
  action_id: string;
  direct_inputs_content_hash: string | null;
  parameters_content_hash: string | null;
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

async function inspectTask(taskId: string) {
  const dbPath = process.env.PLAYTISS_DB_PATH || getDefaultDbPath();
  const db = new sqlite3.Database(dbPath);

  try {
    console.log(`🔍 Inspecting Task: ${taskId}`);
    console.log("━".repeat(60));

    // Get task information
    const task = await new Promise<TaskRow | null>((resolve, reject) => {
      db.get(
        "SELECT * FROM Tasks WHERE task_id = ?",
        [taskId],
        (err, row: TaskRow) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Display basic task info
    console.log(`📋 Task Information:`);
    console.log(`   ID: ${task.task_id}`);
    console.log(`   Scope: ${task.scope_id}`);
    console.log(`   Action ID: ${task.action_id}`);
    console.log(`   Name: ${task.name || "(none)"}`);
    console.log(`   Description: ${task.description || "(none)"}`);
    console.log(
      `   Created: ${new Date(task.timestamp_created).toISOString()}`
    );
    console.log(`   Current Version: ${task.current_version_id || "(none)"}`);
    console.log();

    // Display content hashes
    console.log(`📦 Content Hashes:`);
    console.log(
      `   Direct Inputs: ${task.direct_inputs_content_hash || "(none)"}`
    );
    console.log(`   Parameters: ${task.parameters_content_hash || "(none)"}`);
    console.log();

    // Load and display associated assets
    if (task.direct_inputs_content_hash) {
      await displayAssetPreview(
        "Direct Inputs",
        task.direct_inputs_content_hash
      );
    }

    if (task.parameters_content_hash) {
      await displayAssetPreview("Parameters", task.parameters_content_hash);
    }

    // Get all versions for this task
    const versions = await new Promise<VersionRow[]>((resolve, reject) => {
      db.all(
        "SELECT * FROM Versions WHERE task_id = ? ORDER BY timestamp_created DESC",
        [taskId],
        (err, rows: VersionRow[]) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (versions.length > 0) {
      console.log(`📚 Versions (${versions.length}):`);
      console.log("─".repeat(40));

      for (const version of versions) {
        const isCurrent = version.version_id === task.current_version_id;
        const marker = isCurrent ? "→" : " ";

        console.log(
          `${marker} ${version.version_id} (${version.version_type_tag})`
        );
        console.log(
          `   Created: ${new Date(version.timestamp_created).toISOString()}`
        );
        if (version.user_given_tag)
          console.log(`   Tag: ${version.user_given_tag}`);
        if (version.commit_message)
          console.log(`   Message: ${version.commit_message}`);
        if (version.asset_content_hash)
          console.log(`   Asset: ${version.asset_content_hash}`);
        if (version.parent_version_id)
          console.log(`   Parent: ${version.parent_version_id}`);
        if (version.executed_def_version_id)
          console.log(`   Executed Def: ${version.executed_def_version_id}`);
        console.log();
      }

      // Display current version asset if available
      if (task.current_version_id) {
        const currentVersion = versions.find(
          (v) => v.version_id === task.current_version_id
        );
        if (currentVersion && currentVersion.asset_content_hash) {
          await displayAssetPreview(
            "Current Version Asset",
            currentVersion.asset_content_hash
          );
        }
      }
    } else {
      console.log(`📚 Versions: (none)`);
      console.log();
    }
  } catch (error: any) {
    console.error(`❌ Error inspecting task: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function displayAssetPreview(label: string, assetId: string) {
  try {
    console.log(`📄 ${label}: ${assetId}`);

    if (!isAssetId(assetId)) {
      console.log(`   Invalid asset ID format: ${assetId}`);
      console.log();
      return;
    }

    const data = await load(assetId);
    const preview = JSON.stringify(data, null, 2);

    if (preview.length > 500) {
      console.log(`   ${preview.slice(0, 500)}...`);
      console.log(
        `   [Content truncated - ${preview.length} total characters]`
      );
    } else {
      console.log(`   ${preview}`);
    }

    console.log();
  } catch (error: any) {
    console.log(`   ⚠️ Could not load asset: ${error.message}`);
    console.log();
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const taskId = process.argv[2];

  if (!taskId) {
    console.error("Usage: tsx dev-tools/inspect-task.ts <task-id>");
    console.error("");
    console.error("Example:");
    console.error(
      "  tsx dev-tools/inspect-task.ts 01977aaa-7b52-8f28-8a82-b79755000001"
    );
    process.exit(1);
  }

  inspectTask(taskId);
}
