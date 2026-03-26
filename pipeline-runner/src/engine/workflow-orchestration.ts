// Copyright (c) 2026 Wuji Labs Inc
/**
 * Workflow Orchestration - One-Shot Bootstrap Function
 *
 * This module provides a simple function to bootstrap workflow execution.
 * After the initial setup, the event bus handles all task state updates.
 *
 * Flow:
 * 1. Check if workflow is already completed
 * 2. Parse workflow definition
 * 3. Call handleWorkflowStart to dispatch initial tasks
 * 4. Process any already-completed initial tasks
 * 5. Return - event bus takes over from here
 */

import {
  type AssetId,
  type TraceId,
} from 'playtiss'
import { type Pipeline } from 'playtiss/pipeline'

import { PipelineGraphQLClient } from '../graphql/pipeline.js'
import type { Task } from '../graphql/types.js'
import {
  handleTaskCompletion,
  handleTaskFailure,
  handleWorkflowStart,
} from '../pipeline/scheduler.js'
import { loadCached } from '../utils/asset-cache.js'

// Cache for workflow definitions by their asset hash
const workflowDefinitionCache = new Map<AssetId, Pipeline>()

export interface WorkflowOrchestrationConfig {
  workflowTaskId: TraceId
  workflowTask: Task
  workflowRevisionId: TraceId
  workerId: string
  graphqlClient: PipelineGraphQLClient
}

/**
 * Bootstrap workflow execution
 *
 * @returns true if workflow should continue being monitored, false if already completed
 */
export async function orchestrateWorkflow(
  config: WorkflowOrchestrationConfig,
): Promise<boolean> {
  console.log(`🎬 Bootstrapping workflow ${config.workflowTaskId}`)

  try {
    // Step 1: Check if workflow is already completed
    if (config.workflowTask.currentVersion) {
      switch (config.workflowTask.currentVersion.type) {
        case 'OUTPUT':
          console.log(
            `✅ Workflow ${config.workflowTaskId} already completed with OUTPUT - skipping`,
          )
          return false
        case 'ERROR':
          console.log(
            `💥 Workflow ${config.workflowTaskId} already failed with ERROR - skipping`,
          )
          return false
        case 'REVISION':
          console.log(
            `⚡ Workflow ${config.workflowTaskId} has REVISION - continuing`,
          )
          break
      }
    }

    // Step 2: Parse workflow definition
    const { pipelineRef, definitionHash } = await parseWorkflowDefinition(
      config.workflowTask,
      config.graphqlClient,
    )

    console.log(
      `✅ Loaded workflow definition (${definitionHash}) for ${config.workflowTaskId}`,
    )

    // Step 3: Call handleWorkflowStart to dispatch initial tasks
    const initialTasks = await handleWorkflowStart(
      {
        task: config.workflowTask,
        workflowRevisionId: config.workflowRevisionId,
      },
      pipelineRef,
      3, // concurrency
      config.workerId,
    )

    console.log(
      `📋 handleWorkflowStart returned ${initialTasks.length} initial tasks`,
    )

    // Step 4: Process any already-completed initial tasks
    // (handles race where task completed before orchestration started)
    for (const task of initialTasks) {
      if (task.currentVersion) {
        const taskId = task.id!

        switch (task.currentVersion.type) {
          case 'OUTPUT':
            console.log(
              `✅ Initial task ${taskId} already completed - processing immediately`,
            )
            await processCompletedTask(
              task,
              pipelineRef,
              config.workerId,
              config.workflowRevisionId,
              config.graphqlClient,
            )
            break
          case 'ERROR':
            console.log(
              `💥 Initial task ${taskId} already failed - processing immediately`,
            )
            await processFailedTask(
              task,
              pipelineRef,
              config.workerId,
              config.workflowRevisionId,
              config.graphqlClient,
            )
            break
        }
      }
    }

    // Step 5: Check if workflow is complete after processing initial tasks
    const isComplete = await checkWorkflowCompletion(
      config.workflowTaskId,
      config.graphqlClient,
    )

    if (isComplete) {
      console.log(
        `✅ Workflow ${config.workflowTaskId} completed during bootstrap`,
      )
      return false // No need to continue monitoring
    }

    console.log(
      `✅ Workflow ${config.workflowTaskId} bootstrapped successfully (event bus will handle updates)`,
    )
    return true // Continue monitoring for completion
  }
  catch (error) {
    console.error(
      `❌ Failed to bootstrap workflow ${config.workflowTaskId}:`,
      error,
    )
    throw error
  }
}

/**
 * Parse workflow definition and create pipeline reference
 */
async function parseWorkflowDefinition(
  workflowTask: Task,
  graphqlClient: PipelineGraphQLClient,
): Promise<{
  pipelineRef: AssetId
  definitionHash: AssetId
}> {
  // Get action details to find workflow definition hash
  const actionDetails = await graphqlClient.getActionDetails(
    workflowTask.actionId,
  )

  if (
    !actionDetails?.currentVersion
    || actionDetails.currentVersion.type !== 'WORKFLOW_DEFINITION'
  ) {
    throw new Error(`Action ${workflowTask.actionId} is not a workflow action`)
  }

  const definitionHash = actionDetails.currentVersion
    .asset_content_hash as AssetId

  // Load workflow definition from asset store (with caching)
  await getWorkflowDefinition(definitionHash)

  // pipelineRef is now just the AssetId directly
  const pipelineRef = definitionHash

  return { pipelineRef, definitionHash }
}

/**
 * Process an already-completed task
 * Replicates handleSubtaskSuccess logic from WorkflowOrchestrator
 */
async function processCompletedTask(
  task: Task,
  pipelineRef: AssetId,
  workerId: string,
  workflowRevisionId: TraceId,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  const taskId = task.id!

  if (!task.currentVersion?.asset_content_hash) {
    console.warn(`⚠️  Task ${taskId} has no output asset`)
    return
  }

  // Step 1: Load output asset
  const output = await loadCached(task.currentVersion.asset_content_hash as AssetId)

  // Step 2: Call handleTaskCompletion to propagate to dependent tasks
  const dependentTasks = await handleTaskCompletion(
    { task, output },
    pipelineRef,
    3, // concurrency
    workerId,
    workflowRevisionId,
  )

  // Step 3: Recursively process any dependent tasks that are also already completed/failed
  for (const depTask of dependentTasks) {
    if (depTask.currentVersion) {
      if (depTask.currentVersion.type === 'OUTPUT') {
        await processCompletedTask(
          depTask,
          pipelineRef,
          workerId,
          workflowRevisionId,
          graphqlClient,
        )
      }
      else if (depTask.currentVersion.type === 'ERROR') {
        await processFailedTask(
          depTask,
          pipelineRef,
          workerId,
          workflowRevisionId,
          graphqlClient,
        )
      }
    }
  }

  // Step 4: Update node state to reflect successful completion
  await updateNodeStateForCompletedTask(
    taskId,
    'FRESH',
    'IDLE',
    workflowRevisionId,
    graphqlClient,
  )

  // Step 5: Check if workflow is complete
  // Note: We don't stop monitoring here - that's handled by the workflow engine
  await checkWorkflowCompletion(taskId, graphqlClient)
}

/**
 * Process an already-failed task
 * Replicates handleSubtaskFailure logic from WorkflowOrchestrator
 */
async function processFailedTask(
  task: Task,
  pipelineRef: AssetId,
  workerId: string,
  workflowRevisionId: TraceId,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  const taskId = task.id!

  // Step 1: Load error output (or use empty object)
  let errorOutput: import('playtiss').AssetValue = {}
  if (task.currentVersion?.asset_content_hash) {
    errorOutput = await loadCached(
      task.currentVersion.asset_content_hash as AssetId,
    )
  }

  // Step 2: Call handleTaskFailure
  await handleTaskFailure(
    { task, output: errorOutput },
    pipelineRef,
    3, // concurrency
    workerId,
    workflowRevisionId,
  )

  // Step 3: Update node state to reflect failure
  await updateNodeStateForCompletedTask(
    taskId,
    'STALE',
    'FAILED',
    workflowRevisionId,
    graphqlClient,
  )

  // Step 4: Check if workflow is complete (may have failed due to this task)
  await checkWorkflowCompletion(taskId, graphqlClient)
}

/**
 * Get workflow definition from asset store with caching
 */
async function getWorkflowDefinition(
  definitionHash: AssetId,
): Promise<Pipeline> {
  // Check cache first
  const cached = workflowDefinitionCache.get(definitionHash)
  if (cached) {
    console.log(`📦 Using cached workflow definition for ${definitionHash}`)
    return cached
  }

  // Load from asset store
  const definition = (await loadCached(definitionHash)) as unknown as Pipeline

  if (!isPipeline(definition as unknown)) {
    throw new Error(
      `Asset ${definitionHash} is not a valid pipeline definition`,
    )
  }

  // Cache the definition
  workflowDefinitionCache.set(definitionHash, definition)
  console.log(`💾 Cached workflow definition for ${definitionHash}`)

  return definition
}

/**
 * Type guard to check if object is a valid pipeline
 */
function isPipeline(pipeline: unknown): pipeline is Pipeline {
  return (
    (pipeline as Pipeline).nodes != null && (pipeline as Pipeline).edges != null
  )
}

/**
 * Update WorkflowRevisionNodeStates for a completed/failed task
 * Replicates updateNodeStateForCompletedTask from WorkflowOrchestrator
 */
async function updateNodeStateForCompletedTask(
  taskId: TraceId,
  dependencyStatus: 'FRESH' | 'STALE',
  runtimeStatus: 'IDLE' | 'FAILED',
  workflowRevisionId: TraceId,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  try {
    // Find all workflow nodes that use this task
    const nodeStatesConnection
      = await graphqlClient.listWorkflowRevisionNodeStatesByTask(taskId, 50)

    if (nodeStatesConnection.edges.length === 0) {
      console.warn(`⚠️  No workflow nodes found for task ${taskId}`)
      return
    }

    // Update each node that references this task
    for (const edge of nodeStatesConnection.edges) {
      const nodeState = edge.node
      const nodeUpdates = [
        {
          nodeId: nodeState.nodeIdInWorkflow,
          dependencyStatus,
          runtimeStatus,
          contextAssetHash: nodeState.contextAssetHash,
          requiredTaskId: taskId,
        },
      ]

      const success = await graphqlClient.updateNodeStates(
        nodeState.workflowRevisionId,
        nodeUpdates,
      )

      if (success) {
        console.log(
          `✅ Updated node state: workflow=${nodeState.workflowRevisionId}, node=${nodeState.nodeIdInWorkflow}, task=${taskId}, status=${dependencyStatus}/${runtimeStatus}`,
        )
      }
      else {
        console.error(`❌ Failed to update node state for task ${taskId}`)
      }
    }
  }
  catch (error) {
    console.error(`❌ Error updating node state for task ${taskId}:`, error)
  }
}

/**
 * Check if workflow is complete
 * Replicates checkWorkflowCompletion from WorkflowOrchestrator
 */
async function checkWorkflowCompletion(
  workflowTaskId: TraceId,
  graphqlClient: PipelineGraphQLClient,
): Promise<boolean> {
  try {
    const workflowTask = await graphqlClient.getTask(workflowTaskId)
    if (workflowTask && workflowTask.currentVersion) {
      switch (workflowTask.currentVersion.type) {
        case 'OUTPUT':
          console.log(`🎉 Workflow ${workflowTaskId} completed successfully`)
          return true
        case 'ERROR':
          console.log(`💥 Workflow ${workflowTaskId} failed`)
          return true
      }
    }
    return false
  }
  catch (error) {
    console.error(`❌ Error checking workflow completion:`, error)
    return false
  }
}
