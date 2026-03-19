#!/usr/bin/env tsx
// Copyright (c) 2026 Wuji Labs Inc

/**
 * Dev Helper: Submit Add Task
 *
 * Creates a new computational task using GraphQL API and schedules it for execution
 * This submits work that the python worker can claim and execute
 *
 * Usage: tsx dev-tools/submit-add-task.ts <A> <B>
 * Example: tsx dev-tools/submit-add-task.ts 5 3
 */

import dotenv from "dotenv";

// Load environment configuration
dotenv.config();

import { store } from "playtiss/asset-store";

// add_two action ID - consistent with integration test seed DB
const ADD_ACTION_ID = "019d048e-d525-89ca-8fed-1f12e6000001";

async function submitAddTask(a: number, b: number) {
  try {
    console.log("🚀 Submitting Add Task via GraphQL API...");
    console.log("━".repeat(50));
    console.log(`   A: ${a}`);
    console.log(`   B: ${b}`);
    console.log(`   Expected result: ${a + b}`);

    // Create the task inputs as an asset
    const inputs = { A: a, B: b };
    const inputsAssetId = await store(inputs);
    console.log(`📦 Inputs stored as asset: ${inputsAssetId}`);

    // Create uniqueness hash from inputs - store() returns the hash as part of the asset ID
    // For compound assets, the format is @{hash}, so we extract the hash
    const uniquenessHash = inputsAssetId.startsWith("@")
      ? inputsAssetId.slice(1)
      : inputsAssetId;
    console.log(`🔗 Uniqueness hash: ${uniquenessHash}`);

    // Call GraphQL API to create computational task
    const graphqlUrl =
      process.env.GRAPHQL_URL || "http://localhost:4000/graphql";

    const createTaskMutation = `
      mutation CreateComputationalTask($actionId: ActionId!, $uniquenessHash: String!) {
        createComputationalTask(actionId: $actionId, uniquenessHash: $uniquenessHash) {
          id
          actionId
          inputsContentHash
          name
          description
          createdAt
        }
      }
    `;

    const createTaskResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: createTaskMutation,
        variables: {
          actionId: ADD_ACTION_ID,
          uniquenessHash: uniquenessHash,
        },
      }),
    });

    const createTaskResult = await createTaskResponse.json();

    if (createTaskResult.errors) {
      throw new Error(
        `GraphQL errors: ${JSON.stringify(createTaskResult.errors)}`
      );
    }

    const task = createTaskResult.data.createComputationalTask;
    console.log(`✅ Task created: ${task.id}`);
    console.log(`   Name: ${task.name || "(unnamed)"}`);
    console.log(`   Inputs Hash: ${task.inputsContentHash}`);

    // Schedule task for execution
    const scheduleTaskMutation = `
      mutation ScheduleTask($taskId: TraceId!) {
        scheduleTaskForExecution(taskId: $taskId) {
          taskId
          runtimeStatus
        }
      }
    `;

    const scheduleResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: scheduleTaskMutation,
        variables: {
          taskId: task.id,
        },
      }),
    });

    const scheduleResult = await scheduleResponse.json();

    if (scheduleResult.errors) {
      throw new Error(
        `GraphQL errors: ${JSON.stringify(scheduleResult.errors)}`
      );
    }

    const executionState = scheduleResult.data.scheduleTaskForExecution;
    console.log(`✅ Task scheduled for execution`);
    console.log(`   Status: ${executionState.runtimeStatus}`);

    console.log("━".repeat(50));
    console.log(`🎉 Task submitted successfully!`);
    console.log(`   Execution Task ID: ${task.id}`);
    console.log(`   Status: ${executionState.runtimeStatus}`);
    console.log(`   Ready for worker to claim and execute`);
    console.log();
    console.log(`💡 Monitor with: tsx dev-tools/inspect-task.ts ${task.id}`);
    console.log(
      `💡 Check execution state: tsx dev-tools/inspect-execution-state.ts ${task.id}`
    );
  } catch (error: any) {
    console.error(`❌ Error submitting add task: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseFloat(process.argv[2]);
  const b = parseFloat(process.argv[3]);

  if (isNaN(a) || isNaN(b)) {
    console.error("Usage: tsx dev-tools/submit-add-task.ts <A> <B>");
    console.error("");
    console.error("Example:");
    console.error("  tsx dev-tools/submit-add-task.ts 5 3");
    console.error("  tsx dev-tools/submit-add-task.ts 10.5 2.7");
    process.exit(1);
  }

  // Convert to integers for the add_two function
  const intA = Math.floor(a);
  const intB = Math.floor(b);

  if (intA !== a || intB !== b) {
    console.log(`⚠️  Converting to integers: ${a} → ${intA}, ${b} → ${intB}`);
  }

  submitAddTask(intA, intB);
}
