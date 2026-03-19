// Copyright (c) 2026 Wuji Labs Inc
/**
 * CLI GraphQL Operations
 *
 * All GraphQL queries and mutations used by the CLI tool.
 * Uses graphql-codegen for type generation.
 */

import { graphql } from '../__generated__/index.js'

// ================================================================
// CLIENT MUTATIONS - User-facing operations
// ================================================================

/**
 * Request a new workflow execution
 * Returns a stable Handle ID for tracking
 */
export const REQUEST_EXECUTION = graphql(/* GraphQL */ `
  mutation RequestExecution($actionId: ActionId!, $input: DictJSONAsset!) {
    requestExecution(actionId: $actionId, input: $input)
  }
`)

/**
 * Request stale nodes update (v13 API)
 */
export const REQUEST_STALE_NODES_UPDATE = graphql(/* GraphQL */ `
  mutation RequestStaleNodesUpdate($handleId: TraceId!, $nodeIds: [String!]) {
    requestStaleNodesUpdate(handleId: $handleId, nodeIds: $nodeIds)
  }
`)

/**
 * Submit player input for a workflow node
 */
export const SUBMIT_PLAYER_INPUT = graphql(/* GraphQL */ `
  mutation SubmitPlayerInput(
    $handleId: TraceId!
    $nodeId: String!
    $contextAssetHash: AssetId
    $outputAssetId: AssetId!
    $commitMessage: String
  ) {
    submitPlayerInput(
      handleId: $handleId
      nodeId: $nodeId
      contextAssetHash: $contextAssetHash
      outputAssetId: $outputAssetId
      commitMessage: $commitMessage
    )
  }
`)

/**
 * Mark a player task as failed
 */
export const FAIL_PLAYER_TASK = graphql(/* GraphQL */ `
  mutation FailPlayerTask(
    $handleId: TraceId!
    $nodeId: String!
    $contextAssetHash: AssetId
    $reason: String!
  ) {
    failPlayerTask(
      handleId: $handleId
      nodeId: $nodeId
      contextAssetHash: $contextAssetHash
      reason: $reason
    )
  }
`)

/**
 * Request a node to be rerun
 */
export const REQUEST_NODE_RERUN = graphql(/* GraphQL */ `
  mutation RequestNodeRerun(
    $handleId: TraceId!
    $nodeId: String!
    $contextAssetHash: AssetId
    $commitMessage: String
    $userTag: String
  ) {
    requestNodeRerun(
      handleId: $handleId
      nodeId: $nodeId
      contextAssetHash: $contextAssetHash
      commitMessage: $commitMessage
      userTag: $userTag
    )
  }
`)

// ================================================================
// ACTION & WORKFLOW DEFINITION MUTATIONS
// ================================================================

/**
 * Create a new action
 */
export const CREATE_ACTION = graphql(/* GraphQL */ `
  mutation CreateAction($name: String!, $description: String!) {
    createAction(name: $name, description: $description) {
      id
      name
      description
      createdAt
      currentVersion {
        id
        type
        timestamp_created
      }
    }
  }
`)

/**
 * Create workflow definition version for an action
 */
export const CREATE_WORKFLOW_DEFINITION_VERSION = graphql(/* GraphQL */ `
  mutation CreateWorkflowDefinitionVersion(
    $actionId: TraceId!
    $workflowDefinition: DictJSONAsset!
    $commitMessage: String
  ) {
    createWorkflowDefinitionVersion(
      actionId: $actionId
      workflowDefinition: $workflowDefinition
      commitMessage: $commitMessage
    ) {
      id
      taskId
      type
      asset_content_hash
      timestamp_created
      commit_message
    }
  }
`)

// ================================================================
// CLIENT QUERIES - Status and listing operations
// ================================================================

/**
 * Get workflow revision status by handle ID
 */
export const GET_WORKFLOW_RUN_STATUS = graphql(/* GraphQL */ `
  query GetWorkflowRevisionStatus($handleId: TraceId!) {
    getWorkflowRevisionStatus(handleId: $handleId) {
      id
      status
      createdAt
      nodes {
        nodeIdInWorkflow
        contextAssetHash
        dependencyStatus
        runtimeStatus
        lastUsedVersion {
          id
          type
          timestamp_created
        }
      }
    }
  }
`)

/**
 * Get execution result by handle ID
 */
export const GET_EXECUTION_RESULT = graphql(/* GraphQL */ `
  query GetExecutionResult($handleId: TraceId!) {
    getExecutionResult(handleId: $handleId) {
      id
      type
      timestamp_created
      asset_content_hash
    }
  }
`)

/**
 * Get action details
 */
export const GET_ACTION_DETAILS = graphql(/* GraphQL */ `
  query GetActionDetails($actionId: ActionId!) {
    getActionDetails(actionId: $actionId) {
      id
      name
      description
      createdAt
      currentVersion {
        id
        type
        timestamp_created
      }
    }
  }
`)

/**
 * List all available actions
 */
export const LIST_ACTIONS = graphql(/* GraphQL */ `
  query ListActions($first: Int!, $after: String) {
    listActions(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          createdAt
          currentVersion {
            id
            type
            timestamp_created
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

/**
 * List tasks by action
 */
export const LIST_TASKS_BY_ACTION = graphql(/* GraphQL */ `
  query ListTasksByAction($actionId: ActionId!, $first: Int!, $after: String) {
    listTasksByAction(actionId: $actionId, first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          inputsContentHash
          createdAt
          currentVersion {
            id
            type
            timestamp_created
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

/**
 * List workflow revisions for a task
 */
export const LIST_RUNS_FOR_TASK = graphql(/* GraphQL */ `
  query ListRunsForTask($taskId: TraceId!, $first: Int!, $after: String) {
    listRevisionsForTask(taskId: $taskId, first: $first, after: $after) {
      edges {
        node {
          id
          status
          createdAt
          nodes {
            nodeIdInWorkflow
            dependencyStatus
            runtimeStatus
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

/**
 * Get node state for a specific node
 */
export const GET_NODE_STATE = graphql(/* GraphQL */ `
  query GetNodeState(
    $workflowRevisionId: TraceId!
    $nodeId: String!
    $contextAssetHash: AssetId!
  ) {
    getNodeState(
      workflowRevisionId: $workflowRevisionId
      nodeId: $nodeId
      contextAssetHash: $contextAssetHash
    ) {
      workflowRevisionId
      nodeIdInWorkflow
      contextAssetHash
      requiredTaskId
      lastUsedVersion {
        id
        type
        timestamp_created
      }
      lastInputsHash
      dependencyStatus
      runtimeStatus
    }
  }
`)
