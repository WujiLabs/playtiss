// Copyright (c) 2026 Wuji Labs Inc
/**
 * Task Update Handler - Event-Driven Replacement for WorkflowOrchestrator Polling
 *
 * This module handles task completion and failure events by replicating the exact
 * flow from WorkflowOrchestrator.handleSubtaskUpdate():
 *   handleSubtaskUpdate() → handleSubtaskSuccess() → handleTaskCompletion() → propagateToNode()
 *
 * KEY DIFFERENCE: Instead of being triggered by polling, this is triggered by events.
 *
 * ⚠️ CRITICAL REQUIREMENT (v14 Revision Forking):
 * - MUST use listActiveWorkflowRevisionNodeStatesByTask() - NOT listWorkflowRevisionNodeStatesByTask()
 * - Reason: v14 revision forking creates historical revisions that must NOT be processed
 * - listActiveWorkflowRevisionNodeStatesByTask() returns only latest revision per workflow instance
 * - Using listWorkflowRevisionNodeStatesByTask() would cause events to be applied to ALL revisions
 *   (including historical ones), breaking the immutable history guarantee
 * - This is NOT just a performance optimization - it's a correctness requirement for v14
 *
 * PERFORMANCE BENEFIT (2025-11-20):
 * - Only processes ACTIVE workflow revisions (latest revision version for each workflow instance Task)
 * - Avoids processing stale/historical workflow revisions
 * - Reduces event processing overhead significantly
 */

import type { AssetId, TraceId } from 'playtiss'
import type { Pipeline } from 'playtiss/pipeline'
import type { UserActionId } from 'playtiss/types/playtiss'

import type { PipelineGraphQLClient } from '../graphql/pipeline.js'
import type { Task, workflowRevisionNodeState } from '../graphql/types.js'
import { handleTaskCompletion, handleTaskFailure } from '../pipeline/scheduler.js'
import { loadCached } from '../utils/asset-cache.js'
import type { Event } from './interfaces.js'

/**
 * Handle task_completed event
 *
 * This function replicates the exact logic from:
 * WorkflowOrchestrator.handleSubtaskSuccess()
 *
 * Flow:
 * 1. Get completed task
 * 2. Load output asset
 * 3. Find all workflow revisions that reference this task
 * 4. For each workflow revision, call handleTaskCompletion() (which calls propagateToNode())
 *
 * @param event The task_completed event
 * @param graphqlClient GraphQL client for database operations
 * @param workerId Worker ID for task operations
 */
export async function handleTaskCompletedEvent(
  event: Event,
  graphqlClient: PipelineGraphQLClient,
  workerId: string,
): Promise<void> {
  const { task_id, version_id } = event.payload as {
    task_id: TraceId
    version_id: TraceId
  }

  console.log(
    `🎉 Processing task_completed event: task=${task_id}, version=${version_id}`,
  )

  try {
    // Step 1: Get the completed task (same as WorkflowOrchestrator.handleSubtaskSuccess line 470)
    const task = await graphqlClient.getTask(task_id)
    if (!task) {
      console.warn(`⚠️  Task ${task_id} not found`)
      return
    }

    // Step 2: Verify task has OUTPUT version (same validation as orchestrator line 478-489)
    if (!task.currentVersion || task.currentVersion.type !== 'OUTPUT') {
      console.warn(
        `⚠️  Task ${task_id} currentVersion type is '${task.currentVersion?.type}', expected 'OUTPUT'`,
      )
      return
    }

    if (!task.currentVersion.asset_content_hash) {
      console.warn(
        `⚠️  Task ${task_id} OUTPUT version has no asset_content_hash`,
      )
      return
    }

    // Step 3: Load the actual output data (same as orchestrator line 491-494)
    const outputAssetId = task.currentVersion.asset_content_hash as AssetId
    console.log(
      `📦 Loading output asset for task ${task_id}: ${outputAssetId}`,
    )
    const actualOutput = await loadCached(outputAssetId)
    console.log(
      `📦 Loaded asset has ${typeof actualOutput === 'object' && actualOutput !== null ? Object.keys(actualOutput).length : 0} top-level keys`,
    )

    // Step 4: Find all ACTIVE workflow revisions that use this task
    // ⚠️ CRITICAL: MUST use listActiveWorkflowRevisionNodeStatesByTask() - NOT listWorkflowRevisionNodeStatesByTask()
    // DO NOT change this to listWorkflowRevisionNodeStatesByTask() - it would break v14 revision forking
    // by applying events to historical revisions, violating immutable history guarantee
    // Keep paginating until all records are retrieved
    const workflowRevisions = new Map<
      TraceId,
      Array<{ node: workflowRevisionNodeState, cursor: string }>
    >()
    let after: string | undefined = undefined
    let totalEdges = 0

    do {
      const nodeStatesConnection
        = await graphqlClient.listActiveWorkflowRevisionNodeStatesByTask(
          task_id,
          50, // page size
          after,
        )

      // Group edges by workflow revision ID
      for (const edge of nodeStatesConnection.edges) {
        const revisionId = edge.node.workflowRevisionId
        if (!workflowRevisions.has(revisionId)) {
          workflowRevisions.set(revisionId, [])
        }
        workflowRevisions.get(revisionId)!.push(edge)
      }

      totalEdges += nodeStatesConnection.edges.length
      after = nodeStatesConnection.pageInfo.hasNextPage
        ? nodeStatesConnection.pageInfo.endCursor || undefined
        : undefined
    } while (after)

    if (totalEdges === 0) {
      console.log(
        `ℹ️  No workflow nodes reference task ${task_id} - task may be standalone`,
      )
      return
    }

    console.log(
      `📊 Retrieved ${totalEdges} workflow node states across ${workflowRevisions.size} workflow revision(s)`,
    )

    // Step 6: For each workflow revision, call handleTaskCompletion (orchestrator line 507-513)
    // **THIS IS THE KEY CALL** - Same as WorkflowOrchestrator.handleSubtaskSuccess()
    for (const [workflowRevisionId, edges] of workflowRevisions.entries()) {
      console.log(
        `🔄 Processing workflow revision ${workflowRevisionId} for task ${task_id}`,
      )

      // Get workflow definition for this revision (orchestrator line 240-258)
      const workflowTaskId = await getWorkflowTaskIdFromRevisionId(
        workflowRevisionId,
        graphqlClient,
      )
      if (!workflowTaskId) {
        console.error(
          `❌ Could not find workflow task for revision ${workflowRevisionId}`,
        )
        continue
      }

      const workflowTask = await graphqlClient.getTask(workflowTaskId)
      if (!workflowTask) {
        console.error(`❌ Workflow task ${workflowTaskId} not found`)
        continue
      }

      // Get workflow definition hash (orchestrator line 241-248)
      const actionDetails = await graphqlClient.getActionDetails(
        workflowTask.actionId,
      )
      if (!actionDetails?.currentVersion?.asset_content_hash) {
        console.error(`❌ Workflow ${workflowTaskId} has no definition`)
        continue
      }

      const definitionHash = actionDetails.currentVersion
        .asset_content_hash as AssetId
      const pipelineRef = definitionHash

      // **THIS IS THE KEY CALL** - Same as WorkflowOrchestrator.handleSubtaskSuccess() line 507
      // This will call propagateToNode() and generate dependent tasks
      const dependentTasks = await handleTaskCompletion(
        { task, output: actualOutput },
        pipelineRef,
        3, // concurrency
        workerId,
        workflowRevisionId,
      )

      console.log(
        `✅ Generated ${dependentTasks.length} dependent tasks for workflow ${workflowRevisionId}`,
      )

      // Step 7: Update completed node states to IDLE (task finished successfully)
      // The node's dependencies are still FRESH (no upstream changes), runtime is now IDLE (task completed)
      for (const edge of edges) {
        const nodeState = edge.node
        await graphqlClient.updateNodeStates(workflowRevisionId, [
          {
            nodeId: nodeState.nodeIdInWorkflow,
            dependencyStatus: nodeState.dependencyStatus, // Preserve existing status
            runtimeStatus: 'IDLE' as const, // Mark as IDLE after successful completion
            contextAssetHash: nodeState.contextAssetHash,
            requiredTaskId: nodeState.requiredTaskId,
            lastInputsHash: nodeState.lastInputsHash,
          },
        ])
      }

      console.log(
        `✅ Updated ${edges.length} node(s) to IDLE state in workflow ${workflowRevisionId}`,
      )
    }
  }
  catch (error) {
    console.error(
      `❌ Error handling task_completed event for ${task_id}:`,
      error,
    )
    throw error // Propagate to prevent commit
  }
}

/**
 * Handle task_failed event
 *
 * This function replicates the exact logic from:
 * WorkflowOrchestrator.handleSubtaskFailure()
 *
 * @param event The task_failed event
 * @param graphqlClient GraphQL client for database operations
 * @param workerId Worker ID for task operations
 */
export async function handleTaskFailedEvent(
  event: Event,
  graphqlClient: PipelineGraphQLClient,
  workerId: string,
): Promise<void> {
  const { task_id, version_id } = event.payload as {
    task_id: TraceId
    version_id: TraceId
  }

  console.log(
    `💥 Processing task_failed event: task=${task_id}, version=${version_id}`,
  )

  try {
    // Step 1: Get the failed task (orchestrator line 549)
    const task = await graphqlClient.getTask(task_id)
    if (!task) {
      console.warn(`⚠️  Task ${task_id} not found`)
      return
    }

    // Step 2: Load error output if available (orchestrator line 556-564)
    let errorOutput: import('playtiss').AssetValue = {} // Default empty error
    if (task.currentVersion) {
      if (task.currentVersion.type !== 'ERROR') {
        console.warn(
          `Task ${task_id} currentVersion type is '${task.currentVersion.type}', expected 'ERROR' for failed task`,
        )
      }
      else if (task.currentVersion.asset_content_hash) {
        // Load the actual error data from the asset store
        errorOutput = await loadCached(task.currentVersion.asset_content_hash as AssetId)
      }
    }

    // Step 3: Find all ACTIVE workflow revisions using this task
    // ⚠️ CRITICAL: MUST use listActiveWorkflowRevisionNodeStatesByTask() - NOT listWorkflowRevisionNodeStatesByTask()
    // DO NOT change this to listWorkflowRevisionNodeStatesByTask() - it would break v14 revision forking
    // by applying events to historical revisions, violating immutable history guarantee
    // Keep paginating until all records are retrieved
    const workflowRevisions = new Map<
      TraceId,
      Array<{ node: workflowRevisionNodeState, cursor: string }>
    >()
    let after: string | undefined = undefined
    let totalEdges = 0

    do {
      const nodeStatesConnection
        = await graphqlClient.listActiveWorkflowRevisionNodeStatesByTask(
          task_id,
          50, // page size
          after,
        )

      // Group edges by workflow revision ID
      for (const edge of nodeStatesConnection.edges) {
        const revisionId = edge.node.workflowRevisionId
        if (!workflowRevisions.has(revisionId)) {
          workflowRevisions.set(revisionId, [])
        }
        workflowRevisions.get(revisionId)!.push(edge)
      }

      totalEdges += nodeStatesConnection.edges.length
      after = nodeStatesConnection.pageInfo.hasNextPage
        ? nodeStatesConnection.pageInfo.endCursor || undefined
        : undefined
    } while (after)

    if (totalEdges === 0) {
      console.log(`ℹ️  No workflow nodes reference task ${task_id}`)
      return
    }

    console.log(
      `📊 Retrieved ${totalEdges} workflow node states - task ${task_id} failure affects ${workflowRevisions.size} workflow revision(s)`,
    )

    // Step 5: For each workflow revision, call handleTaskFailure (orchestrator line 575-581)
    for (const [workflowRevisionId, edges] of workflowRevisions.entries()) {
      console.log(
        `🔄 Processing workflow revision ${workflowRevisionId} for failed task ${task_id}`,
      )

      // Get workflow definition (same as handleTaskCompletedEvent)
      const workflowTaskId = await getWorkflowTaskIdFromRevisionId(
        workflowRevisionId,
        graphqlClient,
      )
      if (!workflowTaskId) {
        console.error(
          `❌ Could not find workflow task for revision ${workflowRevisionId}`,
        )
        continue
      }

      const workflowTask = await graphqlClient.getTask(workflowTaskId)
      if (!workflowTask) {
        console.error(`❌ Workflow task ${workflowTaskId} not found`)
        continue
      }

      const actionDetails = await graphqlClient.getActionDetails(
        workflowTask.actionId,
      )
      if (!actionDetails?.currentVersion?.asset_content_hash) {
        console.error(`❌ Workflow ${workflowTaskId} has no definition`)
        continue
      }

      const definitionHash = actionDetails.currentVersion
        .asset_content_hash as AssetId
      const pipelineRef = definitionHash

      // Call handleTaskFailure (orchestrator line 575)
      await handleTaskFailure(
        { task, output: errorOutput },
        pipelineRef,
        3, // concurrency
        workerId,
        workflowRevisionId,
      )

      console.log(`✅ Processed failure for workflow ${workflowRevisionId}`)

      // Update failed node states to FAILED runtime status
      // Preserve dependency status (could be FRESH or STALE)
      for (const edge of edges) {
        const nodeState = edge.node
        await graphqlClient.updateNodeStates(workflowRevisionId, [
          {
            nodeId: nodeState.nodeIdInWorkflow,
            dependencyStatus: nodeState.dependencyStatus, // Preserve existing status
            runtimeStatus: 'FAILED' as const, // Mark as FAILED
            contextAssetHash: nodeState.contextAssetHash,
            requiredTaskId: nodeState.requiredTaskId,
            lastInputsHash: nodeState.lastInputsHash,
          },
        ])
      }

      console.log(
        `✅ Updated ${edges.length} failed node(s) to FAILED state in workflow ${workflowRevisionId}`,
      )
    }
  }
  catch (error) {
    console.error(`❌ Error handling task_failed event for ${task_id}:`, error)
    throw error // Propagate to prevent commit
  }
}

/**
 * Helper: Get workflow task ID from workflow revision ID
 * (Workflow revision ID is actually a revision version ID)
 */
async function getWorkflowTaskIdFromRevisionId(
  revisionId: TraceId,
  graphqlClient: PipelineGraphQLClient,
): Promise<TraceId | null> {
  try {
    const version = await graphqlClient.getVersion(revisionId)
    return version?.taskId || null
  }
  catch (error) {
    console.error(
      `Error getting workflow task ID from revision ID ${revisionId}:`,
      error,
    )
    return null
  }
}

/**
 * Handle stale_update_revision_created event (v13 stale detection)
 *
 * This handler processes the special event emitted by requestStaleNodesUpdate mutation.
 * The Job Task is already COMPLETED when this event is emitted, and a new revision
 * has been created with duplicated node states (STALE nodes remain STALE).
 *
 * Flow:
 * 1. Get WI Task and workflow definition from revision
 * 2. Get all node states from the new revision
 * 3. Filter to STALE nodes (optionally filtered by stale_node_ids)
 * 4. For each STALE node, check if it already has a completed/failed task
 * 5. If task exists and completed, propagate to downstream nodes
 * 6. If no task exists, create task from stored inputs (lastInputsHash)
 *
 * @param event The stale_update_revision_created event
 * @param graphqlClient GraphQL client for database operations
 * @param workerId Worker ID for task operations
 */
export async function handleStaleUpdateRevisionCreated(
  event: Event,
  graphqlClient: PipelineGraphQLClient,
  workerId: string,
): Promise<void> {
  const { wi_task_id, new_revision_id, stale_node_ids } = event.payload as {
    wi_task_id: TraceId
    new_revision_id: TraceId
    stale_node_ids: string[] | null
  }

  console.log(
    `🔄 Processing stale_update_revision_created: revision=${new_revision_id}, wi_task=${wi_task_id}`,
  )

  try {
    // Step 1: Get WI Task to find workflow definition
    const workflowTask = await graphqlClient.getTask(wi_task_id)
    if (!workflowTask) {
      console.error(`❌ WI Task ${wi_task_id} not found`)
      return
    }

    // Step 2: Get workflow definition
    const actionDetails = await graphqlClient.getActionDetails(
      workflowTask.actionId,
    )
    if (!actionDetails?.currentVersion?.asset_content_hash) {
      console.error(`❌ Workflow ${wi_task_id} has no definition`)
      return
    }

    const definitionHash = actionDetails.currentVersion
      .asset_content_hash as AssetId
    const pipelineRef = definitionHash

    // Step 3: Get all node states from the new revision
    // Note: We query the WorkflowRevision which includes all node states
    const workflowRevision = await graphqlClient.getRevision(
      new_revision_id,
    )

    if (!workflowRevision) {
      console.error(`❌ Workflow revision ${new_revision_id} not found`)
      return
    }

    const nodeStates = workflowRevision.nodes

    // Step 4: Filter to only STALE nodes (optionally filtered by stale_node_ids)
    const staleNodes = nodeStates.filter((ns) => {
      const isStale = ns.dependencyStatus === 'STALE'
      const isTargeted
        = !stale_node_ids || stale_node_ids.includes(ns.nodeIdInWorkflow)
      return isStale && isTargeted
    })

    console.log(
      `📊 Found ${staleNodes.length} STALE nodes to process (out of ${nodeStates.length} total nodes)`,
    )

    // Step 5: Update all STALE nodes to IDLE runtime_status
    // This makes them ready for re-execution after revision fork
    if (staleNodes.length > 0) {
      await graphqlClient.updateNodeStates(
        new_revision_id,
        staleNodes.map(ns => ({
          nodeId: ns.nodeIdInWorkflow,
          contextAssetHash: ns.contextAssetHash,
          requiredTaskId: ns.requiredTaskId,
          lastInputsHash: ns.lastInputsHash,
          dependencyStatus: ns.dependencyStatus, // Keep STALE for now
          runtimeStatus: 'IDLE', // Reset to IDLE so they can be re-executed
        })),
      )
      console.log(`✅ Updated ${staleNodes.length} STALE nodes to IDLE`)
    }

    // Step 6: For each STALE node, check if task already exists and process accordingly
    for (const nodeState of staleNodes) {
      await processStaleNode(
        nodeState,
        pipelineRef,
        new_revision_id,
        workerId,
        graphqlClient,
      )
    }

    console.log(
      `✅ Completed processing stale_update_revision_created for revision ${new_revision_id}`,
    )
  }
  catch (error) {
    console.error(`❌ Error handling stale_update_revision_created:`, error)
    throw error
  }
}

/**
 * Process a single STALE node
 *
 * Checks if the node already has a task:
 * - If task exists and is completed: propagate to downstream via handleTaskCompletion
 * - If task exists and is failed: propagate error via handleTaskFailure
 * - If task is still running: do nothing (wait for it to complete)
 * - If no task exists: load inputs from lastInputsHash and create task
 */
async function processStaleNode(
  nodeState: workflowRevisionNodeState,
  pipelineRef: AssetId,
  workflowRevisionId: TraceId,
  workerId: string,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  const nodeId = nodeState.nodeIdInWorkflow

  console.log(`🔍 Processing STALE node: ${nodeId}`)

  let taskId: TraceId
  let task: Task | null = null

  // Step 1: Check if node already has a task
  if (nodeState.requiredTaskId) {
    console.log(`📋 Node ${nodeId} already has task: ${nodeState.requiredTaskId}`)
    taskId = nodeState.requiredTaskId
    task = await graphqlClient.getTask(taskId)

    if (!task) {
      console.error(`❌ Task ${taskId} not found, will recreate`)
      // Fall through to task creation below
    }
    else {
      // Skip to step 6 - check task status
      console.log(`✅ Using existing task ${taskId}, checking status...`)
    }
  }

  // Step 2-5: Create task if it doesn't exist
  if (!task) {
    // Step 2: Check if we have stored inputs to create/find task
    if (!nodeState.lastInputsHash) {
      console.warn(`⚠️  Node ${nodeId} has no lastInputsHash, cannot create task`)
      return
    }

    // Step 3: Load workflow definition to get node action
    const pipelineDefinition = await loadCached(pipelineRef) as unknown as Pipeline
    const nodeDefinition = pipelineDefinition.nodes[nodeId as TraceId]
    if (!nodeDefinition) {
      console.error(`❌ Node ${nodeId} not found in workflow definition`)
      return
    }

    // Step 4: Load the stored inputs from lastInputsHash
    console.log(
      `📦 Loading inputs from hash ${nodeState.lastInputsHash} for node ${nodeId}`,
    )
    const inputs = await loadCached(nodeState.lastInputsHash as AssetId)

    // Step 5: Create or find task using stored inputs
    // The createTask method will handle deduplication via UNIQUE constraint
    // (scope_id, action_id, inputs_content_hash)
    console.log(
      `🏗️  Creating/finding task for STALE node ${nodeId} with action=${nodeDefinition.action}`,
    )

    taskId = await graphqlClient.createTask(
      nodeDefinition.action as UserActionId,
      inputs as import('playtiss').DictAsset,
    )

    console.log(`📋 Task created/found: ${taskId}`)

    // Fetch the task object
    task = await graphqlClient.getTask(taskId)
    if (!task) {
      console.error(`❌ Task ${taskId} not found after creation`)
      return
    }
  }

  // Update node state to mark as FRESH (whether task was existing or newly created)
  await graphqlClient.updateNodeStates(workflowRevisionId, [
    {
      nodeId: nodeId,
      contextAssetHash: nodeState.contextAssetHash,
      requiredTaskId: task.id,
      lastInputsHash: nodeState.lastInputsHash,
      dependencyStatus: 'FRESH', // Task now exists, no longer STALE
      runtimeStatus: nodeState.runtimeStatus as any,
    },
  ])

  // Step 6: Check if task is already completed/failed (due to UNIQUE constraint reuse or existing task)

  if (
    task.currentVersion?.type === 'OUTPUT'
    && task.currentVersion.asset_content_hash
  ) {
    console.log(
      `📦 Task ${task.id} already completed (reused from cache), propagating to downstream`,
    )
    // Load output and propagate to downstream nodes
    const output = await loadCached(
      task.currentVersion.asset_content_hash as AssetId,
    )
    await handleTaskCompletion(
      { task, output },
      pipelineRef,
      3,
      workerId,
      workflowRevisionId,
    )
    return
  }
  else if (
    task.currentVersion?.type === 'ERROR'
    && task.currentVersion.asset_content_hash
  ) {
    console.log(
      `💥 Task ${task.id} already failed (reused from cache), propagating error`,
    )
    const errorOutput = await loadCached(
      task.currentVersion.asset_content_hash as AssetId,
    )
    await handleTaskFailure(
      { task, output: errorOutput },
      pipelineRef,
      3,
      workerId,
      workflowRevisionId,
    )
    return
  }

  // Task is running/pending or newly created - it will be picked up by workers
  console.log(
    `⏳ Task ${task.id} is running/pending (status: ${task.currentVersion?.type || 'no version'})`,
  )
}

/**
 * Handle task_player_submitted event
 *
 * Player input is different from regular task completion:
 * 1. Update the specific node in the workflow with player-provided output
 * 2. Mark downstream nodes as STALE (don't auto-create tasks)
 * 3. Use the NEW revision ID from the event (v14 fork)
 *
 * @param event The task_player_submitted event
 * @param graphqlClient GraphQL client for database operations
 */
export async function handlePlayerSubmittedEvent(
  event: Event,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  const {
    workflow_revision_id,
    node_id,
    output_asset_id,
    task_id,
  } = event.payload as {
    workflow_revision_id: TraceId
    node_id: string
    output_asset_id: AssetId
    task_id: TraceId
  }

  console.log(
    `🎮 Processing task_player_submitted: workflow=${workflow_revision_id}, node=${node_id}, output=${output_asset_id}`,
  )

  try {
    // Step 1: Get the task for this node
    const task = await graphqlClient.getTask(task_id)
    if (!task) {
      console.warn(`⚠️  Task ${task_id} not found for player input`)
      return
    }

    // Step 2: Load player-submitted output
    const playerOutput = await loadCached(output_asset_id)
    console.log(`📦 Loaded player output: ${typeof playerOutput === 'object' && playerOutput !== null ? Object.keys(playerOutput).length : 0} top-level keys`)

    // Step 3: Get workflow definition
    const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflow_revision_id, graphqlClient)
    if (!workflowTaskId) {
      console.error(`❌ Could not find workflow task for revision ${workflow_revision_id}`)
      return
    }

    const workflowTask = await graphqlClient.getTask(workflowTaskId)
    if (!workflowTask) {
      console.error(`❌ Workflow task ${workflowTaskId} not found`)
      return
    }

    const actionDetails = await graphqlClient.getActionDetails(workflowTask.actionId)
    if (!actionDetails?.currentVersion?.asset_content_hash) {
      console.error(`❌ Workflow ${workflowTaskId} has no definition`)
      return
    }

    const definitionHash = actionDetails.currentVersion.asset_content_hash as AssetId
    const pipelineRef = definitionHash

    // Step 4: Call handleTaskCompletion - this will mark downstream nodes as STALE via processNodeReady
    console.log(`🔄 Propagating player input to downstream nodes...`)
    const dependentTasks = await handleTaskCompletion(
      { task, output: playerOutput },
      pipelineRef,
      3, // concurrency
      'player-event-handler',
      workflow_revision_id,
    )

    console.log(
      `✅ Player input processed: ${dependentTasks.length} downstream nodes affected`,
    )
  }
  catch (error) {
    console.error(
      `❌ Error handling task_player_submitted for ${workflow_revision_id}:`,
      error,
    )
    throw error // Propagate to prevent commit
  }
}

/**
 * Handle task_player_failed event
 *
 * Similar to player submitted, but marks the node as failed and propagates error.
 *
 * @param event The task_player_failed event
 * @param graphqlClient GraphQL client for database operations
 */
export async function handlePlayerFailedEvent(
  event: Event,
  graphqlClient: PipelineGraphQLClient,
): Promise<void> {
  const {
    workflow_revision_id,
    node_id,
    reason,
    task_id,
  } = event.payload as {
    workflow_revision_id: TraceId
    node_id: string
    reason: string
    task_id: TraceId
  }

  console.log(
    `🎮❌ Processing task_player_failed: workflow=${workflow_revision_id}, node=${node_id}, reason=${reason}`,
  )

  try {
    // Step 1: Get the task for this node
    const task = await graphqlClient.getTask(task_id)
    if (!task) {
      console.warn(`⚠️  Task ${task_id} not found for player failure`)
      return
    }

    // Step 2: Create error output
    const errorOutput = { error: reason }

    // Step 3: Get workflow definition
    const workflowTaskId = await getWorkflowTaskIdFromRevisionId(workflow_revision_id, graphqlClient)
    if (!workflowTaskId) {
      console.error(`❌ Could not find workflow task for revision ${workflow_revision_id}`)
      return
    }

    const workflowTask = await graphqlClient.getTask(workflowTaskId)
    if (!workflowTask) {
      console.error(`❌ Workflow task ${workflowTaskId} not found`)
      return
    }

    const actionDetails = await graphqlClient.getActionDetails(workflowTask.actionId)
    if (!actionDetails?.currentVersion?.asset_content_hash) {
      console.error(`❌ Workflow ${workflowTaskId} has no definition`)
      return
    }

    const definitionHash = actionDetails.currentVersion.asset_content_hash as AssetId
    const pipelineRef = definitionHash

    // Step 4: Call handleTaskFailure to propagate failure
    console.log(`🔄 Propagating player failure to workflow...`)
    await handleTaskFailure(
      { task, output: errorOutput },
      pipelineRef,
      3, // concurrency
      'player-event-handler',
      workflow_revision_id,
    )

    console.log(`✅ Player failure processed for workflow ${workflow_revision_id}`)
  }
  catch (error) {
    console.error(
      `❌ Error handling task_player_failed for ${workflow_revision_id}:`,
      error,
    )
    throw error // Propagate to prevent commit
  }
}
