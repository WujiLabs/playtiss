// Copyright (c) 2026 Wuji Labs Inc
/**
 * Pipeline Runner GraphQL Client
 *
 * Provides typed GraphQL operations for workflow orchestration:
 * - Task creation, claiming, and result reporting
 * - Workflow node state management (WorkflowRevisionNodeStates)
 * - Task discovery for workers (findRunnableTasks)
 * - Merge accumulator operations for split/merge nodes
 */

import { ApolloClient, from, InMemoryCache } from '@apollo/client/index.js'
import { BatchHttpLink } from '@apollo/client/link/batch-http/index.js'
import { setContext } from '@apollo/client/link/context/index.js'
import { onError } from '@apollo/client/link/error/index.js'
import { RetryLink } from '@apollo/client/link/retry/index.js'
import {
  type ActionId,
  type AssetId,
  type AssetValue,
  computeHash,
  type DictAsset,
  type TraceId,
} from '@playtiss/core'
import http from 'http'
import https from 'https'
import { LRUCache } from 'lru-cache'
import { store } from 'playtiss/asset-store'

import { graphql } from '../__generated__/index.js'
import { getLimiter } from '../utils/concurrency-limiter.js'
import type { Task } from './types.js'

// ================================================================
// GRAPHQL OPERATIONS
// ================================================================

// Get task details
const GET_TASK = graphql(/* GraphQL */ `
  query GetTask($taskId: TraceId!) {
    getTask(taskId: $taskId) {
      id
      actionId
      inputsContentHash
      name
      description
      currentVersion {
        id
        type
        asset_content_hash
        timestamp_created
      }
      createdAt
    }
  }
`)

// Get version details
const GET_VERSION = graphql(/* GraphQL */ `
  query GetVersion($versionId: TraceId!) {
    getVersion(versionId: $versionId) {
      id
      taskId
      type
      asset_content_hash
      parent_version_id
      executed_def_version_id
      timestamp_created
      user_given_tag
      commit_message
    }
  }
`)

// Get task execution state - used for redelivery detection
const GET_TASK_EXECUTION_STATE = graphql(/* GraphQL */ `
  query GetTaskExecutionState($taskId: TraceId!) {
    getTaskExecutionState(taskId: $taskId) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Create computational task (workflow engine exclusive)
const CREATE_COMPUTATIONAL_TASK = graphql(/* GraphQL */ `
  mutation CreateComputationalTask(
    $actionId: ActionId!
    $uniquenessHash: AssetId!
  ) {
    createComputationalTask(
      actionId: $actionId
      uniquenessHash: $uniquenessHash
    ) {
      id
      actionId
      inputsContentHash
      name
      description
      createdAt
    }
  }
`)

// Schedule task for execution (workflow engine exclusive)
const SCHEDULE_TASK_FOR_EXECUTION = graphql(/* GraphQL */ `
  mutation ScheduleTaskForExecution($taskId: TraceId!) {
    scheduleTaskForExecution(taskId: $taskId) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// TODO: Suggest adding this combined mutation to GraphQL server for workflow engine efficiency
// CREATE_TASK_AND_SCHEDULE = gql`
//   mutation CreateTaskAndSchedule(
//     $actionId: ActionId!
//     $inputs: DictJSONAsset!
//     $contextAssetHash: AssetId
//     $name: String
//     $description: String
//   ) {
//     createTaskAndSchedule(
//       actionId: $actionId
//       inputs: $inputs
//       contextAssetHash: $contextAssetHash
//       name: $name
//       description: $description
//     ) {
//       taskId
//       scheduled
//     }
//   }
// `;

// Claim task for execution
const CLAIM_TASK = graphql(/* GraphQL */ `
  mutation ClaimTask($taskId: TraceId!, $workerId: String!, $ttl: Int!) {
    claimTask(taskId: $taskId, workerId: $workerId, ttl: $ttl) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Refresh task - resets completed task back to PENDING state
const REFRESH_TASK = graphql(/* GraphQL */ `
  mutation RefreshTask($taskId: TraceId!) {
    refreshTask(taskId: $taskId) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Claim workflow task and generate revision version (workflow engine exclusive)
const CLAIM_WORKFLOW_TASK = graphql(/* GraphQL */ `
  mutation ClaimWorkflowTask(
    $taskId: TraceId!
    $workerId: String!
    $ttl: Int!
  ) {
    claimWorkflowTask(taskId: $taskId, workerId: $workerId, ttl: $ttl) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Report task success
const REPORT_TASK_SUCCESS = graphql(/* GraphQL */ `
  mutation ReportTaskSuccess(
    $taskId: TraceId!
    $resultVersionId: TraceId!
    $workerId: String!
  ) {
    reportTaskSuccess(
      taskId: $taskId
      resultVersionId: $resultVersionId
      workerId: $workerId
    ) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Report task failure
const REPORT_TASK_FAILURE = graphql(/* GraphQL */ `
  mutation ReportTaskFailure(
    $taskId: TraceId!
    $errorVersionId: TraceId!
    $workerId: String!
  ) {
    reportTaskFailure(
      taskId: $taskId
      errorVersionId: $errorVersionId
      workerId: $workerId
    ) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

// Create version for task output or error
const CREATE_VERSION = graphql(/* GraphQL */ `
  mutation CreateVersion(
    $taskId: TraceId!
    $versionType: VersionType!
    $asset_content_hash: AssetId
    $commit_message: String
  ) {
    createVersion(
      taskId: $taskId
      versionType: $versionType
      asset_content_hash: $asset_content_hash
      commit_message: $commit_message
    ) {
      id
      type
      asset_content_hash
      timestamp_created
    }
  }
`)

// Update node states in workflow
const UPDATE_NODE_STATES = graphql(/* GraphQL */ `
  mutation UpdateNodeStates(
    $revisionId: TraceId!
    $nodeUpdates: [NodeStateUpdateInput!]!
  ) {
    updateNodeStates(revisionId: $revisionId, nodeUpdates: $nodeUpdates) {
      id
      status
    }
  }
`)

// Fork workflow revision (v14 Copy-on-Write)
const FORK_WORKFLOW_REVISION = graphql(/* GraphQL */ `
  mutation ForkWorkflowRevision(
    $taskId: TraceId!
    $currentRevisionId: TraceId!
    $triggerReason: String
  ) {
    forkWorkflowRevision(
      taskId: $taskId
      currentRevisionId: $currentRevisionId
      triggerReason: $triggerReason
    )
  }
`)

// Monitor task execution states
const FIND_RUNNABLE_TASKS = graphql(/* GraphQL */ `
  query FindRunnableTasks($actionId: ActionId, $first: Int, $after: String) {
    findRunnableTasks(actionId: $actionId, first: $first, after: $after) {
      edges {
        node {
          taskId
          runtimeStatus
          claim_timestamp
          claim_worker_id
          claim_ttl_seconds
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

// Get workflow revision node state by exact lookup
const GET_WORKFLOW_REVISION_NODE_STATE = graphql(/* GraphQL */ `
  query GetWorkflowRevisionNodeState(
    $workflowRevisionId: TraceId!
    $nodeIdInWorkflow: String!
    $contextAssetHash: AssetId!
  ) {
    getWorkflowRevisionNodeState(
      workflowRevisionId: $workflowRevisionId
      nodeIdInWorkflow: $nodeIdInWorkflow
      contextAssetHash: $contextAssetHash
    ) {
      nodeIdInWorkflow
      contextAssetHash
      requiredTaskId
      dependencyStatus
      runtimeStatus
      lastUsedVersion {
        id
        type
        asset_content_hash
        timestamp_created
      }
    }
  }
`)

// Get action details (used by event handlers to get workflow definition)
const GET_ACTION_DETAILS = graphql(/* GraphQL */ `
  query GetActionDetails($actionId: ActionId!) {
    getActionDetails(actionId: $actionId) {
      id
      name
      description
      currentVersion {
        id
        type
        asset_content_hash
        timestamp_created
      }
      createdAt
    }
  }
`)

// Get workflow revision by version ID (used by event handlers to get full workflow state)
const GET_REVISION = graphql(/* GraphQL */ `
  query GetRevision($versionId: TraceId!) {
    getRevision(versionId: $versionId) {
      id
      status
      createdAt
      nodes {
        workflowRevisionId
        nodeIdInWorkflow
        contextAssetHash
        requiredTaskId
        dependencyStatus
        runtimeStatus
        lastInputsHash
        metaAssetHash
        lastUsedVersion {
          id
          type
          asset_content_hash
        }
      }
    }
  }
`)

// Get node state (used by pipeline-runner to check if node already executed)
const GET_NODE_STATE = graphql(/* GraphQL */ `
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
      dependencyStatus
      runtimeStatus
      lastInputsHash
      metaAssetHash
      lastUsedVersion {
        id
        type
        asset_content_hash
        timestamp_created
      }
    }
  }
`)

// List workflow revision node states by task ID (reverse lookup)
const LIST_WORKFLOW_REVISION_NODE_STATES_BY_TASK = graphql(/* GraphQL */ `
  query ListWorkflowRevisionNodeStatesByTask(
    $taskId: TraceId!
    $workflowRevisionId: TraceId
    $first: Int
    $after: String
  ) {
    listWorkflowRevisionNodeStatesByTask(
      taskId: $taskId
      workflowRevisionId: $workflowRevisionId
      first: $first
      after: $after
    ) {
      edges {
        cursor
        node {
          workflowRevisionId
          nodeIdInWorkflow
          contextAssetHash
          requiredTaskId
          dependencyStatus
          runtimeStatus
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

// List ACTIVE workflow revision node states by task (reverse lookup)
// Only returns node states from the latest (active) revision version of each workflow instance
const LIST_ACTIVE_WORKFLOW_REVISION_NODE_STATES_BY_TASK = graphql(/* GraphQL */ `
  query ListActiveWorkflowRevisionNodeStatesByTask(
    $taskId: TraceId!
    $first: Int
    $after: String
  ) {
    listActiveWorkflowRevisionNodeStatesByTask(
      taskId: $taskId
      first: $first
      after: $after
    ) {
      edges {
        cursor
        node {
          workflowRevisionId
          nodeIdInWorkflow
          contextAssetHash
          requiredTaskId
          dependencyStatus
          runtimeStatus
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

// Merge Accumulator Operations (v14.1)
const SET_MERGE_ACCUMULATOR = graphql(/* GraphQL */ `
  mutation SetMergeAccumulator(
    $pipelineId: AssetId!
    $workflowRevisionId: TraceId!
    $contextAssetHash: AssetId!
    $nodeId: String!
    $accumulatorData: DictJSONAsset!
  ) {
    setMergeAccumulator(
      pipelineId: $pipelineId
      workflowRevisionId: $workflowRevisionId
      contextAssetHash: $contextAssetHash
      nodeId: $nodeId
      accumulatorData: $accumulatorData
    )
  }
`)

const MERGE_MERGE_ACCUMULATOR = graphql(/* GraphQL */ `
  mutation MergeMergeAccumulator(
    $pipelineId: AssetId!
    $workflowRevisionId: TraceId!
    $contextAssetHash: AssetId!
    $nodeId: String!
    $key: String!
    $value: JSONAsset!
  ) {
    mergeMergeAccumulator(
      pipelineId: $pipelineId
      workflowRevisionId: $workflowRevisionId
      contextAssetHash: $contextAssetHash
      nodeId: $nodeId
      key: $key
      value: $value
    )
  }
`)

const DELETE_MERGE_ACCUMULATOR = graphql(/* GraphQL */ `
  mutation DeleteMergeAccumulator(
    $pipelineId: AssetId!
    $workflowRevisionId: TraceId!
    $contextAssetHash: AssetId!
    $nodeId: String!
  ) {
    deleteMergeAccumulator(
      pipelineId: $pipelineId
      workflowRevisionId: $workflowRevisionId
      contextAssetHash: $contextAssetHash
      nodeId: $nodeId
    )
  }
`)

const GET_MERGE_ACCUMULATOR = graphql(/* GraphQL */ `
  query GetMergeAccumulator(
    $pipelineId: AssetId!
    $workflowRevisionId: TraceId!
    $contextAssetHash: AssetId!
    $nodeId: String!
  ) {
    getMergeAccumulator(
      pipelineId: $pipelineId
      workflowRevisionId: $workflowRevisionId
      contextAssetHash: $contextAssetHash
      nodeId: $nodeId
    )
  }
`)

// ================================================================
// CLIENT IMPLEMENTATION
// ================================================================

export class PipelineGraphQLClient {
  private client: ApolloClient<unknown>
  private taskCache: LRUCache<string, Promise<TraceId>>
  private inputHashCache: LRUCache<string, AssetId>
  private nodeStateCache: LRUCache<string, Promise<void>>

  constructor(
    graphqlUrl: string = process.env.PLAYTISS_GRAPHQL_ENDPOINT
      || 'http://localhost:4000/graphql',
  ) {
    // Initialize LRU cache for task creation promise deduplication
    // Cache key: ${actionId}:${uniquenessHash} -> Promise<TraceId>
    //
    // IMPORTANT: We cache promises (both in-flight and resolved) for deduplication:
    // - In-flight promises: Multiple concurrent identical requests await the same promise
    // - Resolved promises: Subsequent calls return cached task ID immediately
    // - Task IDs are immutable: same (actionId, uniquenessHash) always maps to same taskId
    this.taskCache = new LRUCache<string, Promise<TraceId>>({
      max: 10000, // Cache up to 10k task creation promises
      ttl: 1000 * 60 * 60, // 1 hour TTL (task IDs never change once created)
      updateAgeOnGet: true, // Refresh TTL on cache hits
    })

    // Initialize LRU cache for input asset hash computation
    // Cache key: computeHash(input) -> uniquenessHash (AssetId)
    //
    // Eliminates redundant S3 store() calls for identical inputs
    // Uses computeHash() for efficient fixed-length cache keys (SHA-256 hash, not full JSON)
    this.inputHashCache = new LRUCache<string, AssetId>({
      max: 1000, // Cache up to 1k unique inputs
      ttl: 1000 * 60 * 60, // 1 hour TTL (inputs are immutable)
      updateAgeOnGet: true, // Refresh TTL on access
    })

    // Initialize LRU cache for node state update promise deduplication
    // Cache key: ${revisionId}:${nodeId}:${contextHash}:${taskId}:${depStatus}:${runtimeStatus} -> Promise<void>
    //
    // IMPORTANT: We cache promises (both in-flight and resolved) for deduplication:
    // - In-flight promises: Multiple concurrent identical requests await the same promise
    // - Resolved promises: Subsequent calls return cached success immediately
    // - Since updateNodeStates() is idempotent (INSERT ON CONFLICT DO UPDATE with COALESCE),
    //   we can safely skip duplicate calls with identical parameters
    this.nodeStateCache = new LRUCache<string, Promise<void>>({
      max: 10000, // Cache up to 10k node state update promises
      ttl: 1000 * 60 * 60, // 1 hour TTL
      updateAgeOnGet: true, // Refresh TTL on access
    })
    // Configure HTTP agent with increased socket pool and connection reuse
    // Use appropriate agent based on URL protocol
    const isHttps = graphqlUrl.startsWith('https://')
    const agentOptions = {
      maxSockets: 200, // 4x increase from AWS default (50)
      keepAlive: true, // Reuse connections
      keepAliveMsecs: 30000, // Keep connections alive for 30s
    }
    const httpAgent = isHttps
      ? new https.Agent(agentOptions)
      : new http.Agent(agentOptions)

    // Configure BatchHttpLink for request consolidation
    const batchHttpLink = new BatchHttpLink({
      uri: graphqlUrl,
      batchMax: 15, // Optimize for similar workflow operations
      batchInterval: 20, // 20ms batching window
      fetchOptions: {
        agent: httpAgent, // Use custom agent with increased socket pool
      },
    })

    // Configure authentication if needed (for production environments)
    const authLink = setContext((_, { headers }) => {
      // Note: In production, you might want to add authentication headers here
      return {
        headers: {
          ...headers,
          // Authorization: `Bearer ${token}`, // Add if needed
        },
      }
    })

    // Configure retry logic for resilience
    const retryLink = new RetryLink({
      delay: {
        initial: 300,
        max: Infinity,
        jitter: true,
      },
      attempts: {
        max: 3,
        retryIf: error => !!error,
      },
    })

    // Configure error handling
    const errorLink = onError(
      ({ graphQLErrors, networkError }) => {
        if (graphQLErrors) {
          graphQLErrors.forEach(({ message, locations, path }) => {
            console.error(
              `[GraphQL error]: Message: ${message}, Location: ${locations}, Path: ${path}`,
            )
          })
        }

        if (networkError) {
          console.error(`[Network error]: ${networkError}`)

          // For ECONNRESET and similar network issues, don't crash the process
          if (
            networkError.message.includes('ECONNRESET')
            || networkError.message.includes('fetch failed')
          ) {
            console.warn(
              '🔄 Network error detected, operation will be retried by RetryLink',
            )
          }
        }
      },
    )

    this.client = new ApolloClient({
      link: from([errorLink, retryLink, authLink, batchHttpLink]),
      cache: new InMemoryCache({
        typePolicies: {
          Version: {
            // Versions are immutable - cache them for the lifetime of the client
            fields: {
              id: { merge: false },
              taskId: { merge: false },
              type: { merge: false },
              asset_content_hash: { merge: false },
              timestamp_created: { merge: false },
            },
          },
          Task: {
            // Tasks are mostly immutable except for currentVersion
            fields: {
              currentVersion: { merge: true },
            },
          },
        },
      }),
      defaultOptions: {
        query: {
          // Use network-only as default for real-time workflow data
          fetchPolicy: 'network-only',
          errorPolicy: 'all',
        },
        mutate: {
          errorPolicy: 'all',
        },
      },
    })
  }

  // ================================================================
  // TASK EXECUTION API
  // ================================================================

  /**
   * Get input asset hash with caching to avoid redundant S3 store() calls
   *
   * Uses computeHash() for efficient fixed-length cache key generation
   * Avoids redundant S3 calls for identical inputs
   * Limits concurrency of store() operations to prevent S3 socket saturation
   */
  private async getInputAssetHash(input: DictAsset): Promise<AssetId> {
    // Use computeHash() to create stable cache key (fixed-length hash, no S3 calls)
    const cacheKey = await computeHash(input)

    const cached = this.inputHashCache.get(cacheKey)
    if (cached) {
      return cached
    }

    // Cache miss - compute and store with concurrency limiting
    const s3StoreLimiter = getLimiter('s3-store')
    const uniquenessHash = await s3StoreLimiter(async () => {
      return await store(input)
    })

    this.inputHashCache.set(cacheKey, uniquenessHash)
    return uniquenessHash
  }

  /**
   * Create computational task and schedule for execution.
   * Returns unchangeable taskId (not Handle ID)
   *
   * IMPORTANT: This method only returns the task ID, not the task content!
   * - Task creation promises are cached in LRU cache for deduplication
   * - Callers must call getTask(taskId) separately to fetch task content
   * - This separation allows task content (currentVersion, etc.) to be fetched fresh
   */
  async createTask(
    actionId: ActionId,
    input: DictAsset,
  ): Promise<TraceId> {
    // Step 1: Compute uniqueness hash with caching
    // Context is only recorded in WorkflowRevisionNodeStates, not part of uniqueness
    const uniquenessHash = await this.getInputAssetHash(input)

    // Step 2: Check cache for existing promise (in-flight or resolved)
    const cacheKey = `${actionId}:${uniquenessHash}`
    const cachedPromise = this.taskCache.get(cacheKey)
    if (cachedPromise) {
      // Either in-flight or already resolved promise
      console.log(
        `🔄 Deduplicating task creation (cached promise): ${cacheKey}`,
      )
      return await cachedPromise
    }

    // Step 3: Create and cache new promise for task creation
    const taskPromise = this.createTaskInternal(
      actionId,
      uniquenessHash,
    )
    this.taskCache.set(cacheKey, taskPromise)

    try {
      return await taskPromise
    }
    catch (error) {
      // Remove failed promise from cache to allow retry
      this.taskCache.delete(cacheKey)
      console.error(`Failed to create task for action ${actionId}:`, error)
      throw error
    }
  }

  private async createTaskInternal(
    actionId: ActionId,
    uniquenessHash: AssetId,
  ): Promise<TraceId> {
    // Step 1: Create computational task
    const taskResponse = await this.client.mutate({
      mutation: CREATE_COMPUTATIONAL_TASK,
      variables: {
        actionId,
        uniquenessHash,
      },
    })

    if (!taskResponse.data?.createComputationalTask) {
      console.error('CreateComputationalTask failed:', {
        actionId,
        uniquenessHash,
        errors: taskResponse.errors,
        data: taskResponse.data,
      })
      throw new Error(
        `Failed to create computational task for action ${actionId}: ${JSON.stringify(taskResponse.errors || 'Unknown error')}`,
      )
    }

    const task = taskResponse.data.createComputationalTask
    const taskId = task.id as TraceId

    // Step 2: Schedule task for execution (creates TaskExecutionStates entry)
    const scheduleResponse = await this.client.mutate({
      mutation: SCHEDULE_TASK_FOR_EXECUTION,
      variables: { taskId },
    })

    if (!scheduleResponse.data?.scheduleTaskForExecution) {
      console.warn(`Task created but scheduling failed for ${taskId}`)
      // Throw error - promise will be removed from cache by caller
      throw new Error(`Failed to schedule task ${taskId} for execution`)
    }

    // Return taskId - promise is already cached in createTask()
    return taskId
  }

  /**
   * Claim task for execution
   */
  async claimTask(
    taskId: TraceId,
    workerId: string,
    ttl: number = 300,
  ): Promise<boolean> {
    try {
      const response = await this.client.mutate({
        mutation: CLAIM_TASK,
        variables: {
          taskId,
          workerId,
          ttl,
        },
      })

      return response.data?.claimTask?.taskId === taskId
    }
    catch (error) {
      console.error(`Failed to claim task ${taskId}:`, error)
      return false
    }
  }

  /**
   * Refresh task - resets a completed task (SUCCEEDED/FAILED) back to PENDING state
   * Used for redelivery scenarios where task needs to be re-executed
   */
  async refreshTask(taskId: TraceId): Promise<boolean> {
    try {
      const response = await this.client.mutate({
        mutation: REFRESH_TASK,
        variables: {
          taskId,
        },
      })

      return response.data?.refreshTask?.taskId === taskId
    }
    catch (error) {
      console.error(`Failed to refresh task ${taskId}:`, error)
      return false
    }
  }

  /**
   * Claim workflow task and generate revision version ID
   * Workflow Engine exclusive - generates workflowRevisionId for state tracking
   */
  async claimWorkflowTask(
    taskId: TraceId,
    workerId: string,
    ttl: number = 300,
  ): Promise<{ claimed: boolean, workflowRevisionId?: TraceId }> {
    try {
      console.log(
        `🔧 Attempting to claim workflow task ${taskId} with worker ${workerId}`,
      )

      const response = await this.client.mutate({
        mutation: CLAIM_WORKFLOW_TASK,
        variables: {
          taskId,
          workerId,
          ttl,
        },
      })

      console.log(`🔧 ClaimWorkflowTask GraphQL response:`, {
        hasErrors: !!(response.errors && response.errors.length > 0),
        errors: response.errors,
        hasData: !!response.data,
        claimWorkflowTask: response.data?.claimWorkflowTask,
        fullResponse: response,
      })

      const claimResult = response.data?.claimWorkflowTask
      const claimed = claimResult?.taskId === taskId

      console.log(
        `🔧 Claim evaluation: claimResult=${JSON.stringify(claimResult)}, taskId=${taskId}, claimed=${claimed}`,
      )

      if (claimed) {
        // Get the revision version ID that was generated
        const taskWithRevision = await this.getTask(taskId)
        const workflowRevisionId = taskWithRevision?.currentVersion?.id

        if (workflowRevisionId) {
          console.log(
            `✅ Claimed workflow task ${taskId} with workflowRevisionId ${workflowRevisionId}`,
          )
          return { claimed: true, workflowRevisionId }
        }
        else {
          console.warn(
            `⚠️  Claimed workflow task ${taskId} but no workflowRevisionId found`,
          )
          return { claimed: true }
        }
      }
      else {
        console.warn(
          `❌ Claim failed for task ${taskId}: claimResult=${JSON.stringify(claimResult)}`,
        )
        return { claimed: false }
      }
    }
    catch (error) {
      console.error(`Failed to claim workflow task ${taskId}:`, error)
      return { claimed: false }
    }
  }

  /**
   * Create a version for task output or error
   */
  async createVersion(
    taskId: TraceId,
    versionType:
      | 'OUTPUT'
      | 'ERROR'
      | 'WORKFLOW_DEFINITION'
      | 'IMPLEMENTATION'
      | 'REVISION',
    assetContentHash?: AssetId,
    commitMessage?: string,
  ): Promise<TraceId | null> {
    try {
      console.log(
        `🔧 Creating version - taskId: ${taskId}, type: ${versionType}, asset: ${assetContentHash}`,
      )

      const response = await this.client.mutate({
        mutation: CREATE_VERSION,
        variables: {
          taskId,
          versionType,
          asset_content_hash: assetContentHash,
          commit_message: commitMessage,
        },
      })

      console.log(`🔧 GraphQL response structure:`, {
        hasErrors: !!(response.errors && response.errors.length > 0),
        hasData: !!response.data,
        hasCreateVersion: !!response.data?.createVersion,
        fullResponse: response,
      })

      // Better error handling for GraphQL responses
      if (response.errors && response.errors.length > 0) {
        console.error(
          `GraphQL errors creating version for task ${taskId}:`,
          response.errors,
        )
        return null
      }

      if (!response.data?.createVersion) {
        console.error(
          `No createVersion data in response for task ${taskId}:`,
          response,
        )
        return null
      }

      const versionId = response.data.createVersion.id
      console.log(`✅ Created version ${versionId} for task ${taskId}`)
      return versionId || null
    }
    catch (error) {
      console.error(`Failed to create version for task ${taskId}:`, error)
      return null
    }
  }

  /**
   * Report task success (low-level method)
   * Note: Requires pre-created version ID
   */
  async reportTaskSuccess(
    taskId: TraceId,
    resultVersionId: TraceId,
    workerId: string,
  ): Promise<boolean> {
    try {
      const response = await this.client.mutate({
        mutation: REPORT_TASK_SUCCESS,
        variables: {
          taskId,
          resultVersionId,
          workerId,
        },
      })

      return response.data?.reportTaskSuccess?.taskId === taskId
    }
    catch (error) {
      console.error(`Failed to report task success ${taskId}:`, error)
      return false
    }
  }

  /**
   * Report task success with output (convenience method)
   */
  async reportTaskSuccessWithOutput(
    taskId: TraceId,
    output: DictAsset,
    workerId: string,
    commitMessage?: string,
  ): Promise<boolean> {
    try {
      // Step 1: Store output and create OUTPUT version
      const outputAssetHash = await store(output)

      const versionId = await this.createVersion(
        taskId,
        'OUTPUT',
        outputAssetHash,
        commitMessage || 'Task completed successfully',
      )

      if (!versionId) {
        throw new Error('Failed to create OUTPUT version')
      }

      // Step 2: Report success with version ID
      return await this.reportTaskSuccess(taskId, versionId, workerId)
    }
    catch (error) {
      console.error(
        `Failed to report task success with output ${taskId}:`,
        error,
      )
      return false
    }
  }

  /**
   * Report task failure (low-level method)
   * Note: Requires pre-created version ID
   */
  async reportTaskFailure(
    taskId: TraceId,
    errorVersionId: TraceId,
    workerId: string,
  ): Promise<boolean> {
    try {
      const response = await this.client.mutate({
        mutation: REPORT_TASK_FAILURE,
        variables: {
          taskId,
          errorVersionId,
          workerId,
        },
      })

      return response.data?.reportTaskFailure?.taskId === taskId
    }
    catch (error) {
      console.error(`Failed to report task failure ${taskId}:`, error)
      return false
    }
  }

  /**
   * Report task failure with error (convenience method)
   */
  async reportTaskFailureWithError(
    taskId: TraceId,
    error: DictAsset,
    workerId: string,
    commitMessage?: string,
  ): Promise<boolean> {
    try {
      // Step 1: Store error and create ERROR version
      const errorAssetHash = await store(error)

      const versionId = await this.createVersion(
        taskId,
        'ERROR',
        errorAssetHash,
        commitMessage || 'Task failed',
      )

      if (!versionId) {
        throw new Error('Failed to create ERROR version')
      }

      // Step 2: Report failure with version ID
      return await this.reportTaskFailure(taskId, versionId, workerId)
    }
    catch (error) {
      console.error(
        `Failed to report task failure with error ${taskId}:`,
        error,
      )
      return false
    }
  }

  // ================================================================
  // TASK & VERSION QUERIES
  // ================================================================

  /**
   * Get task details by task ID
   */
  async getTask(taskId: TraceId): Promise<Task | null> {
    try {
      const response = await this.client.query({
        query: GET_TASK,
        variables: { taskId },
        fetchPolicy: 'network-only',
      })

      if (!response.data?.getTask) {
        return null
      }

      return response.data.getTask
    }
    catch (error) {
      console.error(`Failed to get task ${taskId}:`, error)
      return null
    }
  }

  /**
   * Get task execution state - checks runtime status (PENDING/RUNNING/SUCCEEDED/FAILED)
   * Used for redelivery detection: if task is in terminal state, needs refresh+claim
   */
  async getTaskExecutionState(taskId: TraceId): Promise<{ runtimeStatus: string } | null> {
    try {
      const response = await this.client.query({
        query: GET_TASK_EXECUTION_STATE,
        variables: { taskId },
        fetchPolicy: 'network-only',
      })

      if (!response.data?.getTaskExecutionState) {
        return null
      }

      return {
        runtimeStatus: response.data.getTaskExecutionState.runtimeStatus,
      }
    }
    catch (error) {
      console.error(`Failed to get task execution state ${taskId}:`, error)
      return null
    }
  }

  /**
   * Get version details by version ID
   * Uses caching for immutable version data
   */
  async getVersion(versionId: TraceId) {
    try {
      const response = await this.client.query({
        query: GET_VERSION,
        variables: { versionId },
        fetchPolicy: 'cache-first', // Versions are immutable, cache aggressively
      })

      if (!response.data?.getVersion) {
        return null
      }

      return response.data.getVersion
    }
    catch (error) {
      console.error(`Failed to get version ${versionId}:`, error)
      return null
    }
  }

  // ================================================================
  // WORKFLOW STATE API
  // ================================================================

  /**
   * Update node states in workflow.
   *
   * Uses LRU cache to deduplicate identical calls since updateNodeStates is idempotent
   * (INSERT ON CONFLICT DO UPDATE with COALESCE preserves existing values)
   */
  async updateNodeStates(
    revisionId: TraceId,
    nodeUpdates: Array<{
      nodeId: string
      dependencyStatus?: 'FRESH' | 'STALE'
      runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
      contextAssetHash: AssetId
      requiredTaskId?: TraceId | null
      lastInputsHash?: AssetId | null
      metaAssetHash?: AssetId | null
    }>,
  ): Promise<boolean> {
    try {
      // Group updates by cache key and check for cached promises
      const updateGroups = new Map<string, (typeof nodeUpdates)[0][]>()
      const cachedPromises: Promise<void>[] = []

      for (const update of nodeUpdates) {
        const cacheKey = `${revisionId}:${update.nodeId}:${update.contextAssetHash}:${update.requiredTaskId ?? ''}:${update.dependencyStatus ?? ''}:${update.runtimeStatus ?? ''}:${update.lastInputsHash ?? ''}:${update.metaAssetHash ?? ''}`

        const cachedPromise = this.nodeStateCache.get(cacheKey)
        if (cachedPromise) {
          // Already in cache (in-flight or resolved)
          cachedPromises.push(cachedPromise)
        }
        else {
          // Need to execute this update
          if (!updateGroups.has(cacheKey)) {
            updateGroups.set(cacheKey, [])
          }
          updateGroups.get(cacheKey)!.push(update)
        }
      }

      // If all updates are cached, await cached promises and return
      if (updateGroups.size === 0) {
        await Promise.all(cachedPromises)
        return true
      }

      // Create promises for uncached updates
      const uncachedUpdates = Array.from(updateGroups.values()).flat()
      const updatePromise = this.updateNodeStatesInternal(
        revisionId,
        uncachedUpdates,
      )

      // Cache the promise for each update
      const cacheKeys = Array.from(updateGroups.keys())
      for (const cacheKey of cacheKeys) {
        this.nodeStateCache.set(cacheKey, updatePromise)
      }

      try {
        // Wait for all promises (both cached and new)
        await Promise.all([...cachedPromises, updatePromise])
        return true
      }
      catch (error) {
        // Remove failed promises from cache to allow retry
        for (const cacheKey of cacheKeys) {
          this.nodeStateCache.delete(cacheKey)
        }
        throw error
      }
    }
    catch (error) {
      console.error('Failed to update node states:', error)
      return false
    }
  }

  private async updateNodeStatesInternal(
    revisionId: TraceId,
    nodeUpdates: Array<{
      nodeId: string
      dependencyStatus?: 'FRESH' | 'STALE'
      runtimeStatus?: 'IDLE' | 'RUNNING' | 'FAILED' | 'PENDING_PLAYER_INPUT'
      contextAssetHash: AssetId
      requiredTaskId?: TraceId | null
      lastInputsHash?: AssetId | null
    }>,
  ): Promise<void> {
    const taskUpdateLimiter = getLimiter('task-update')

    // Execute mutation with concurrency limiting
    const response = await taskUpdateLimiter(async () => {
      return await this.client.mutate({
        mutation: UPDATE_NODE_STATES,
        variables: { revisionId, nodeUpdates },
      })
    })

    const success = response.data?.updateNodeStates?.id === revisionId
    if (!success) {
      throw new Error(`Failed to update node states for revision ${revisionId}`)
    }
  }

  /**
   * Fork workflow revision (v14 Copy-on-Write)
   * Creates a new revision by copying all node states from the current revision
   * Used when redelivery or intervention occurs to preserve history
   *
   * @param taskId - The workflow instance task ID
   * @param currentRevisionId - The current revision ID (before fork)
   * @param triggerReason - Reason for forking (e.g., "Redelivery of node X")
   * @returns New revision ID
   */
  async forkWorkflowRevision(
    taskId: TraceId,
    currentRevisionId: TraceId,
    triggerReason?: string,
  ): Promise<TraceId> {
    try {
      const response = await this.client.mutate({
        mutation: FORK_WORKFLOW_REVISION,
        variables: { taskId, currentRevisionId, triggerReason },
      })

      const newRevisionId = response.data?.forkWorkflowRevision
      if (!newRevisionId) {
        throw new Error(`Failed to fork revision for task ${taskId}`)
      }

      console.log(`🔀 Forked revision: ${currentRevisionId} → ${newRevisionId}`)
      return newRevisionId as TraceId
    }
    catch (error) {
      console.error(`Failed to fork workflow revision:`, error)
      throw error
    }
  }

  // ================================================================
  // TASK DISCOVERY API
  // ================================================================

  /**
   * Find runnable tasks for a specific action
   */
  async findRunnableTasks(
    options: {
      actionId?: ActionId
      first?: number
      after?: string
    } = {},
  ) {
    try {
      const response = await this.client.query({
        query: FIND_RUNNABLE_TASKS,
        variables: {
          actionId: options.actionId,
          first: options.first || 50,
          after: options.after,
        },
        fetchPolicy: 'network-only',
      })

      return (
        response.data?.findRunnableTasks || {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }
      )
    }
    catch (error) {
      console.error('Failed to find runnable tasks:', error)
      return { edges: [], pageInfo: { hasNextPage: false, endCursor: null } }
    }
  }

  // ================================================================
  // WORKFLOW NODE STATE QUERIES
  // ================================================================

  /**
   * Get workflow revision node state for a specific node
   * Used by getTaskForNode in model-v12.ts
   */
  async getWorkflowRevisionNodeState(
    workflowRevisionId: TraceId,
    nodeIdInWorkflow: string,
    contextAssetHash: AssetId,
  ) {
    try {
      const response = await this.client.query({
        query: GET_WORKFLOW_REVISION_NODE_STATE,
        variables: { workflowRevisionId, nodeIdInWorkflow, contextAssetHash },
        fetchPolicy: 'network-only',
      })

      return response.data?.getWorkflowRevisionNodeState || null
    }
    catch (error) {
      console.error('Error fetching workflow revision node state:', error)
      throw error
    }
  }

  /**
   * Get node state by exact lookup (used by pipeline-runner for stale detection)
   * Similar to getWorkflowRevisionNodeState but uses nodeId (String) instead of nodeIdInWorkflow
   * and includes lastInputsHash field for stale detection
   */
  async getNodeState(
    workflowRevisionId: TraceId,
    nodeId: string,
    contextAssetHash: AssetId,
  ) {
    try {
      const response = await this.client.query({
        query: GET_NODE_STATE,
        variables: { workflowRevisionId, nodeId, contextAssetHash },
        fetchPolicy: 'network-only',
      })

      return response.data?.getNodeState || null
    }
    catch (error) {
      console.error('Error fetching node state:', error)
      throw error
    }
  }

  /**
   * Get action details
   * Returns action metadata including current version and definition hash
   * Used by event handlers to get workflow definition
   */
  async getActionDetails(actionId: ActionId) {
    try {
      const response = await this.client.query({
        query: GET_ACTION_DETAILS,
        variables: { actionId },
        fetchPolicy: 'network-only',
      })

      return response.data?.getActionDetails || null
    }
    catch (error) {
      console.error('Error fetching action details:', error)
      throw error
    }
  }

  /**
   * Get workflow revision by version ID
   * Returns the full workflow revision with all node states
   * Used by event handlers to get complete workflow state after revision fork
   */
  async getRevision(versionId: TraceId) {
    try {
      const response = await this.client.query({
        query: GET_REVISION,
        variables: { versionId },
        fetchPolicy: 'network-only',
      })

      return response.data?.getRevision || null
    }
    catch (error) {
      console.error('Error fetching workflow revision by version ID:', error)
      throw error
    }
  }

  /**
   * List workflow revision node states by task ID (reverse lookup)
   * Used by getWorkflowNodesForTask in model-v12.ts
   * @param workflowRevisionId Optional workflow revision ID for server-side filtering optimization
   */
  async listWorkflowRevisionNodeStatesByTask(
    taskId: TraceId,
    first: number = 50,
    after?: string,
    workflowRevisionId?: TraceId,
  ) {
    try {
      const response = await this.client.query({
        query: LIST_WORKFLOW_REVISION_NODE_STATES_BY_TASK,
        variables: { taskId, workflowRevisionId, first, after },
        fetchPolicy: 'network-only',
      })

      return (
        response.data?.listWorkflowRevisionNodeStatesByTask || {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }
      )
    }
    catch (error) {
      console.error('Error fetching workflow revision node states by task:', error)
      throw error
    }
  }

  /**
   * List ACTIVE workflow revision node states by task ID (reverse lookup)
   * Only returns node states from the latest (active) revision version of each workflow instance
   * Used by event-bus/task-update-handler.ts for event-driven workflow orchestration
   */
  async listActiveWorkflowRevisionNodeStatesByTask(
    taskId: TraceId,
    first: number = 50,
    after?: string,
  ) {
    try {
      const response = await this.client.query({
        query: LIST_ACTIVE_WORKFLOW_REVISION_NODE_STATES_BY_TASK,
        variables: { taskId, first, after },
        fetchPolicy: 'network-only',
      })

      return (
        response.data?.listActiveWorkflowRevisionNodeStatesByTask || {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }
      )
    }
    catch (error) {
      console.error('Error fetching active workflow revision node states by task:', error)
      throw error
    }
  }

  // ================================================================
  // MERGE ACCUMULATOR OPERATIONS (v14.1)
  // ================================================================

  /**
   * Set/overwrite merge accumulator state atomically
   * Used when merge node receives all inputs and becomes ready
   *
   * @param accumulatorData - DictAsset that may contain CompoundAssetReferences
   */
  async setMergeAccumulator(
    pipelineId: AssetId,
    workflowRevisionId: TraceId,
    contextAssetHash: AssetId,
    nodeId: string,
    accumulatorData: DictAsset,
  ): Promise<boolean> {
    try {
      // Pass DictAsset directly — the DictJSONAsset scalar handles serialization
      const response = await this.client.mutate({
        mutation: SET_MERGE_ACCUMULATOR,
        variables: {
          pipelineId,
          workflowRevisionId,
          contextAssetHash,
          nodeId,
          accumulatorData: accumulatorData,
        },
      })

      return response.data?.setMergeAccumulator ?? false
    }
    catch (error) {
      console.error('Error setting merge accumulator:', error)
      throw error
    }
  }

  /**
   * Atomically merge update: read current state, update one key, write back
   * Returns the updated accumulator state as DictAsset
   * Used when merge node receives partial input
   *
   * @param key - The key to update in the accumulator
   * @param value - Any AssetValue value (primitive, array, dict, CID, etc.)
   * @returns DictAsset - The complete updated accumulator state
   */
  async mergeMergeAccumulator(
    pipelineId: AssetId,
    workflowRevisionId: TraceId,
    contextAssetHash: AssetId,
    nodeId: string,
    key: string,
    value: AssetValue,
  ): Promise<DictAsset | null> {
    try {
      // Pass AssetValue directly — the JSONAsset scalar handles serialization
      const response = await this.client.mutate({
        mutation: MERGE_MERGE_ACCUMULATOR,
        variables: {
          pipelineId,
          workflowRevisionId,
          contextAssetHash,
          nodeId,
          key,
          value: value,
        },
      })

      const result = response.data?.mergeMergeAccumulator
      if (!result) {
        return null
      }

      // Result is already a DictAsset from the GraphQL scalar
      return result as DictAsset
    }
    catch (error) {
      console.error('Error merging merge accumulator:', error)
      throw error
    }
  }

  /**
   * Delete merge accumulator when task is scheduled
   */
  async deleteMergeAccumulator(
    pipelineId: AssetId,
    workflowRevisionId: TraceId,
    contextAssetHash: AssetId,
    nodeId: string,
  ): Promise<boolean> {
    try {
      const response = await this.client.mutate({
        mutation: DELETE_MERGE_ACCUMULATOR,
        variables: {
          pipelineId,
          workflowRevisionId,
          contextAssetHash,
          nodeId,
        },
      })

      return response.data?.deleteMergeAccumulator ?? false
    }
    catch (error) {
      console.error('Error deleting merge accumulator:', error)
      throw error
    }
  }

  /**
   * Get current merge accumulator state (for debugging)
   * Returns DictAsset with reconstructed CompoundAssetReferences
   */
  async getMergeAccumulator(
    pipelineId: AssetId,
    workflowRevisionId: TraceId,
    contextAssetHash: AssetId,
    nodeId: string,
  ): Promise<DictAsset | null> {
    try {
      const response = await this.client.query({
        query: GET_MERGE_ACCUMULATOR,
        variables: {
          pipelineId,
          workflowRevisionId,
          contextAssetHash,
          nodeId,
        },
        fetchPolicy: 'network-only',
      })

      const result = response.data?.getMergeAccumulator
      if (!result) {
        return null
      }

      // Result is already a DictAsset from the GraphQL scalar
      return result as DictAsset
    }
    catch (error) {
      console.error('Error getting merge accumulator:', error)
      throw error
    }
  }

  // ================================================================
  // CLEANUP
  // ================================================================

  async close(): Promise<void> {
    await this.client.stop()
  }
}
