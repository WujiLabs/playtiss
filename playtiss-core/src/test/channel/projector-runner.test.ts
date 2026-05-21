// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest'

import { applyTask } from '../../channel/apply-task.js'
import {
  buildTopicIndex,
  depsOf,
  dispatchOrderForTopic,
  topoSort,
} from '../../channel/projector-runner.js'
import { type Task, type TaskId, taskRef } from '../../channel/types.js'

function noopApply(): void { /* test stub */ }

function task(id: TaskId, action: string, input: Task['input']): Task {
  return { id, action, input, apply: noopApply }
}

describe('depsOf', () => {
  it('returns empty when no TaskRefs are present', () => {
    expect(depsOf({})).toEqual([])
    expect(depsOf({ topics: ['foo', 'bar'] })).toEqual([])
    expect(depsOf({ nested: { deep: { primitive: 42 } } })).toEqual([])
  })

  it('finds a top-level TaskRef', () => {
    expect(depsOf({ upstream: taskRef('t-A' as TaskId) })).toEqual(['t-A'])
  })

  it('finds nested TaskRefs in object values', () => {
    const input = {
      session_index: taskRef('t-sessions' as TaskId),
      revisions: taskRef('t-revisions' as TaskId),
    }
    expect(depsOf(input).sort()).toEqual(['t-revisions', 't-sessions'])
  })

  it('finds TaskRefs inside arrays', () => {
    const input = {
      upstreams: [taskRef('t-A' as TaskId), taskRef('t-B' as TaskId)],
    }
    expect(depsOf(input)).toEqual(['t-A', 't-B'])
  })

  it('does NOT recurse into the TaskRef.id string itself', () => {
    expect(depsOf({ ref: taskRef('t-A' as TaskId) })).toEqual(['t-A'])
  })

  it('skips primitive values cleanly', () => {
    expect(depsOf({ topics: ['x'], n: 1, b: true, s: 'foo', nul: null })).toEqual([])
  })
})

describe('topoSort', () => {
  it('orders independents in input order', () => {
    const a = task('t-A' as TaskId, 'a', { topics: ['x'] })
    const b = task('t-B' as TaskId, 'b', { topics: ['y'] })
    expect(topoSort([a, b]).map(t => t.id)).toEqual(['t-A', 't-B'])
  })

  it('respects single dep edge', () => {
    const a = task('t-A' as TaskId, 'a', {})
    const b = task('t-B' as TaskId, 'b', { upstream: taskRef('t-A' as TaskId) })
    expect(topoSort([b, a]).map(t => t.id)).toEqual(['t-A', 't-B'])
  })

  it('respects chained deps regardless of input order', () => {
    const sessions = task('t-sessions' as TaskId, 'index-sessions', {})
    const revisions = task('t-revisions' as TaskId, 'project-revisions', {
      session_index: taskRef('t-sessions' as TaskId),
    })
    const branchViews = task('t-branchViews' as TaskId, 'project-branch-views', {
      upstream_revisions: taskRef('t-revisions' as TaskId),
    })
    const sorted = topoSort([branchViews, revisions, sessions])
    expect(sorted.map(t => t.id)).toEqual(['t-sessions', 't-revisions', 't-branchViews'])
  })

  it('throws on a 2-cycle', () => {
    const a = task('t-A' as TaskId, 'a', { peer: taskRef('t-B' as TaskId) })
    const b = task('t-B' as TaskId, 'b', { peer: taskRef('t-A' as TaskId) })
    expect(() => topoSort([a, b])).toThrow(/cycle/)
  })

  it('throws on TaskRef pointing at unregistered TaskId', () => {
    const t = task('t-orphan' as TaskId, 'orphan', {
      ghost: taskRef('t-NEVER-REGISTERED' as TaskId),
    })
    expect(() => topoSort([t])).toThrow(/unregistered/)
  })
})

describe('buildTopicIndex + dispatchOrderForTopic', () => {
  it('returns multiple tasks for a shared topic in dep order', () => {
    const sessions = task('t-sessions' as TaskId, 'a', { topics: ['shared'] })
    const revisions = task('t-revisions' as TaskId, 'b', {
      topics: ['shared'],
      session_index: taskRef('t-sessions' as TaskId),
    })
    const sorted = topoSort([revisions, sessions])
    const index = buildTopicIndex(sorted)
    expect(dispatchOrderForTopic('shared', index).map(t => t.id))
      .toEqual(['t-sessions', 't-revisions'])
  })

  it('returns empty for unsubscribed topic', () => {
    const a = task('t-A' as TaskId, 'a', { topics: ['x'] })
    const sorted = topoSort([a])
    const index = buildTopicIndex(sorted)
    expect(dispatchOrderForTopic('y', index)).toEqual([])
  })
})

describe('applyTask (content-hashed TaskId)', () => {
  it('same (action, input) → same TaskId', async () => {
    const id1 = await applyTask('proxy.project-revisions', { topics: ['x'] })
    const id2 = await applyTask('proxy.project-revisions', { topics: ['x'] })
    expect(id1).toBe(id2)
  })

  it('different action → different TaskId', async () => {
    const id1 = await applyTask('a', { topics: ['x'] })
    const id2 = await applyTask('b', { topics: ['x'] })
    expect(id1).not.toBe(id2)
  })

  it('TaskRef inside Input affects the hash', async () => {
    const id1 = await applyTask('a', { upstream: taskRef('t-X' as TaskId) })
    const id2 = await applyTask('a', { upstream: taskRef('t-Y' as TaskId) })
    expect(id1).not.toBe(id2)
  })

  it('input field order does NOT affect the hash (dag-json canonicalization)', async () => {
    const id1 = await applyTask('a', { topics: ['x'], extra: 'foo' })
    const id2 = await applyTask('a', { extra: 'foo', topics: ['x'] } as Task['input'])
    expect(id1).toBe(id2)
  })
})
