// Copyright (c) 2026 Wuji Labs Inc
/**
 * GraphQL Client for TypeScript Worker
 *
 * This module provides GraphQL queries and mutations for the decoupled
 * architecture where Workers communicate with the central GraphQL server.
 *
 * Based on the Python playtiss-action-runner gql_client.py implementation.
 * Uses generated types from GraphQL codegen.
 */
import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client/index.js'
import type { ActionId, AssetId, TraceId } from 'playtiss'
import type { VersionType } from './__generated__/graphql.js'
import { graphql } from './__generated__/index.js'

// GraphQL Queries and Mutations using codegen
const FIND_RUNNABLE_TASKS = graphql(/* GraphQL */ `
  query FindRunnableTasks(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $actionId: ActionId
  ) {
    findRunnableTasks(
      first: $first
      after: $after
      last: $last
      before: $before
      actionId: $actionId
    ) {
      edges {
        cursor
        node {
          taskId
          runtimeStatus
          claim_timestamp
          claim_worker_id
          claim_ttl_seconds
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`)

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

const REPORT_TASK_SUCCESS = graphql(/* GraphQL */ `
  mutation ReportTaskSuccess(
    $taskId: TraceId!
    $workerId: String!
    $resultVersionId: TraceId!
  ) {
    reportTaskSuccess(
      taskId: $taskId
      workerId: $workerId
      resultVersionId: $resultVersionId
    ) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

const REPORT_TASK_FAILURE = graphql(/* GraphQL */ `
  mutation ReportTaskFailure(
    $taskId: TraceId!
    $workerId: String!
    $errorVersionId: TraceId!
  ) {
    reportTaskFailure(
      taskId: $taskId
      workerId: $workerId
      errorVersionId: $errorVersionId
    ) {
      taskId
      runtimeStatus
      claim_timestamp
      claim_worker_id
      claim_ttl_seconds
    }
  }
`)

const GET_TASK = graphql(/* GraphQL */ `
  query GetTask($taskId: TraceId!) {
    getTask(taskId: $taskId) {
      id
      actionId
      inputsContentHash
      name
      description
      createdAt
      currentVersion {
        id
        type
        asset_content_hash
        timestamp_created
      }
    }
  }
`)

const CREATE_VERSION = graphql(/* GraphQL */ `
  mutation CreateVersion(
    $taskId: TraceId!
    $versionType: VersionType!
    $assetContentHash: AssetId
    $commitMessage: String
  ) {
    createVersion(
      taskId: $taskId
      versionType: $versionType
      asset_content_hash: $assetContentHash
      commit_message: $commitMessage
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

export class GraphQLClient {
  private client: ApolloClient<unknown>
  private _workerId?: string

  constructor(url: string, headers: Record<string, string> = {}) {
    const httpLink = createHttpLink({
      uri: url,
      headers,
    })

    this.client = new ApolloClient({
      link: httpLink,
      cache: new InMemoryCache(),
    })

    // Extract workerId from headers for consistency
    this._workerId = headers['X-Worker-Id']
  }

  get workerId(): string | undefined {
    return this._workerId
  }

  async findRunnableTasks(params: {
    first?: number
    after?: string
    last?: number
    before?: string
    actionId?: ActionId
  }) {
    const response = await this.client.query({
      query: FIND_RUNNABLE_TASKS,
      variables: params,
      fetchPolicy: 'network-only',
    })

    return response.data.findRunnableTasks
  }

  async claimTask(params: {
    taskId: TraceId
    workerId: string
    ttl: number
  }) {
    try {
      const response = await this.client.mutate({
        mutation: CLAIM_TASK,
        variables: params,
      })

      return response.data?.claimTask ?? null
    }
    catch (error) {
      // Task already claimed or no longer available
      console.debug(`Could not claim task ${params.taskId}:`, error)
      return null
    }
  }

  async reportTaskSuccess(params: {
    taskId: TraceId
    workerId: string
    resultVersionId: TraceId
  }) {
    const response = await this.client.mutate({
      mutation: REPORT_TASK_SUCCESS,
      variables: params,
    })

    return response.data!.reportTaskSuccess
  }

  async reportTaskFailure(params: {
    taskId: TraceId
    workerId: string
    errorVersionId: TraceId
  }) {
    const response = await this.client.mutate({
      mutation: REPORT_TASK_FAILURE,
      variables: params,
    })

    return response.data!.reportTaskFailure
  }

  async getTask(taskId: TraceId) {
    const response = await this.client.query({
      query: GET_TASK,
      variables: { taskId },
      fetchPolicy: 'network-only',
    })

    return response.data.getTask
  }

  async createVersion(params: {
    taskId: TraceId
    versionType: VersionType
    assetContentHash?: AssetId
    commitMessage?: string
  }) {
    const response = await this.client.mutate({
      mutation: CREATE_VERSION,
      variables: params,
    })

    return response.data!.createVersion
  }

  async close(): Promise<void> {
    // Apollo Client cleanup
    await this.client.clearStore()
    this.client.stop()
  }
}

/**
 * Create a GraphQL client with optional authentication
 */
export function createClient(
  url: string,
  workerId?: string,
  authToken?: string,
) {
  const headers: Record<string, string> = {}

  if (workerId) {
    headers['X-Worker-Id'] = workerId
  }

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  return new GraphQLClient(url, headers)
}

// Re-export types for external use
export type { Task, Version } from './types.js'
