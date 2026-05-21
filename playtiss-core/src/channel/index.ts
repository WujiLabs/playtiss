// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// @playtiss/core/channel — the SQLite reference Channel for v1 Protocol.
//
// Public API surface, v0.3:
//
//   - createChannel(opts): Channel
//   - migrate(db): runs channel-owned schema migrations (must be called
//     before constructing a Channel)
//   - applyTask(action, input): Promise<TaskId>
//   - taskRef(id): TaskRef
//   - isTaskRef(value): boolean
//   - topoSort / buildTopicIndex / dispatchOrderForTopic / depsOf
//     (pure helpers for consumers that want to drive their own dispatch
//     loop on top of the channel substrate)
//   - SqliteStorageProvider (re-exported for advanced consumers that want
//     to attach a storage provider to a foreign DB handle)
//
// Type re-exports:
//   - Channel, ChannelOptions
//   - Task, TaskRef, TaskInput
//   - Outcome, SubmitResult
//   - Event, BlobRef, KV
//   - ActionId, TaskId, Database

export { applyTask } from './apply-task.js'
export { createChannel } from './channel.js'
export { CURRENT_CHANNEL_SCHEMA_VERSION, migrate } from './migrate.js'
export {
  buildTopicIndex,
  depsOf,
  dispatchOrderForTopic,
  topoSort,
} from './projector-runner.js'
export { SqliteStorageProvider } from './storage.js'
export type {
  ActionId,
  BlobRef,
  Channel,
  ChannelOptions,
  Database,
  Event,
  KV,
  Outcome,
  SubmitResult,
  Task,
  TaskId,
  TaskInput,
  TaskRef,
} from './types.js'
export { isTaskRef, taskRef } from './types.js'
