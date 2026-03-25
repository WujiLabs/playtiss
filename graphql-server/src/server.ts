// Copyright (c) 2026 Wuji Labs Inc
import { ApolloServer } from '@apollo/server'
import { readFileSync } from 'fs'
import type { Resolvers } from './__generated__/graphql.js'

// Scalar imports
import { ActionIdScalar } from './scalars/action_id.js'
import { AssetIdScalar } from './scalars/asset_id.js'
import { DateScalar } from './scalars/date.js'
import { DictJSONAssetScalar } from './scalars/json_asset.js'
import { SystemActionIdScalar } from './scalars/system_action_id.js'
import { TraceIdScalar } from './scalars/trace_id.js'

// Query resolver imports
import {
  findProcessableRevisions as queryFindProcessableRevisions,
  findRunnableTasks as queryFindRunnableTasks,
  getActionDetails as queryGetActionDetails,
  getExecutionResult as queryGetExecutionResult,
  getMergeAccumulator as queryGetMergeAccumulator,
  getNodeState as queryGetNodeState,
  getProfile as queryGetProfile,
  getRevision as queryGetRevision,
  getTask as queryGetTask,
  getTaskExecutionState as queryGetTaskExecutionState,
  getVersion as queryGetVersion,
  getWorkflowRevisionNodeState as queryGetWorkflowRevisionNodeState,
  getWorkflowRevisionStatus as queryGetWorkflowRevisionStatus,
  getInterceptorSession as queryGetInterceptorSession,
  listActions as queryListActions,
  listActiveWorkflowRevisionNodeStatesByTask as queryListActiveWorkflowRevisionNodeStatesByTask,
  listRevisionsForTask as queryListRevisionsForTask,
  listTasksByAction as queryListTasksByAction,
  listWorkflowRevisionNodeStatesByTask as queryListWorkflowRevisionNodeStatesByTask,
} from './resolvers/queries.js'

// Mutation resolver imports
import {
  claimTask as mutationClaimTask,
  claimWorkflowTask as mutationClaimWorkflowTask,
  createAction as mutationCreateAction,
  createComputationalTask as mutationCreateComputationalTask,
  createVersion as mutationCreateVersion,
  createWorkflowDefinitionVersion as mutationCreateWorkflowDefinitionVersion,
  deleteMergeAccumulator as mutationDeleteMergeAccumulator,
  failPlayerTask as mutationFailPlayerTask,
  forkWorkflowRevision as mutationForkWorkflowRevision,
  mergeMergeAccumulator as mutationMergeMergeAccumulator,
  refreshTask as mutationRefreshTask,
  reportTaskFailure as mutationReportTaskFailure,
  reportTaskSuccess as mutationReportTaskSuccess,
  requestExecution as mutationRequestExecution,
  requestNodeRerun as mutationRequestNodeRerun,
  requestStaleNodesUpdate as mutationRequestStaleNodesUpdate,
  scheduleTaskForExecution as mutationScheduleTaskForExecution,
  saveInterceptorSession as mutationSaveInterceptorSession,
  setMergeAccumulator as mutationSetMergeAccumulator,
  submitPlayerInput as mutationSubmitPlayerInput,
  updateNodeStates as mutationUpdateNodeStates,
} from './resolvers/mutations.js'

// Export typeDefs and resolvers for shared use
export const typeDefs = readFileSync('./schema.graphql', { encoding: 'utf-8' })

export const resolvers: Resolvers = {
  ActionId: ActionIdScalar,
  AssetId: AssetIdScalar,
  TraceId: TraceIdScalar,
  SystemActionId: SystemActionIdScalar,
  Date: DateScalar,
  DictJSONAsset: DictJSONAssetScalar,
  Query: {
    getProfile: queryGetProfile,
    getTask: queryGetTask,
    getVersion: queryGetVersion,
    getActionDetails: queryGetActionDetails,
    getWorkflowRevisionStatus: queryGetWorkflowRevisionStatus,
    getRevision: queryGetRevision,
    getExecutionResult: queryGetExecutionResult,
    listActions: queryListActions,
    listTasksByAction: queryListTasksByAction,
    listRevisionsForTask: queryListRevisionsForTask,
    findProcessableRevisions: queryFindProcessableRevisions,
    findRunnableTasks: queryFindRunnableTasks,
    getWorkflowRevisionNodeState: queryGetWorkflowRevisionNodeState,
    getNodeState: queryGetNodeState,
    listWorkflowRevisionNodeStatesByTask:
      queryListWorkflowRevisionNodeStatesByTask,
    listActiveWorkflowRevisionNodeStatesByTask:
      queryListActiveWorkflowRevisionNodeStatesByTask,
    getMergeAccumulator: queryGetMergeAccumulator,
    getTaskExecutionState: queryGetTaskExecutionState,
    getInterceptorSession: queryGetInterceptorSession,
  },
  Mutation: {
    createAction: mutationCreateAction,
    createComputationalTask: mutationCreateComputationalTask,
    createVersion: mutationCreateVersion,
    createWorkflowDefinitionVersion: mutationCreateWorkflowDefinitionVersion,
    requestExecution: mutationRequestExecution,
    requestNodeRerun: mutationRequestNodeRerun,
    requestStaleNodesUpdate: mutationRequestStaleNodesUpdate,
    submitPlayerInput: mutationSubmitPlayerInput,
    failPlayerTask: mutationFailPlayerTask,
    forkWorkflowRevision: mutationForkWorkflowRevision,
    updateNodeStates: mutationUpdateNodeStates,
    scheduleTaskForExecution: mutationScheduleTaskForExecution,
    claimTask: mutationClaimTask,
    claimWorkflowTask: mutationClaimWorkflowTask,
    reportTaskSuccess: mutationReportTaskSuccess,
    reportTaskFailure: mutationReportTaskFailure,
    refreshTask: mutationRefreshTask,
    setMergeAccumulator: mutationSetMergeAccumulator,
    mergeMergeAccumulator: mutationMergeMergeAccumulator,
    deleteMergeAccumulator: mutationDeleteMergeAccumulator,
    saveInterceptorSession: mutationSaveInterceptorSession,
  },
}

// Factory function to create Apollo Server with optional plugins
export function createApolloServer(
  plugins?: any[],
): ApolloServer {
  return new ApolloServer({
    typeDefs,
    resolvers,
    plugins,
    // Enable HTTP request batching for improved performance
    // This allows BatchHttpLink clients to send multiple operations in a single HTTP request
    allowBatchedHttpRequests: true,
  })
}
