// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Compile-time and runtime tests for the relationship generics.
// Most assertions here are "does this compile?" — we encode conformance checks
// as type-level assertions that would break the build if the generics drift.

import { describe, expect, it } from 'vitest'

import type { AssetId } from '../asset-id.js'
import type { DictAsset } from '../asset-value.js'
import type {
  ActionId,
  ActorId,
  DefaultAction,
  DefaultRevision,
  DefaultTask,
  NamespacedActionId,
  RevisionId,
  RevisionLike,
  SystemActionId,
  TaskId,
  TaskLike,
  UserActionId,
  ValueOrLink,
} from '../task.js'
import { isSystemAction } from '../task.js'

// ----------------------------------------------------------------------------
// Type-level conformance tests (verified at build time; vitest just ensures
// the module compiles when these assertions run).
// ----------------------------------------------------------------------------

describe('relationship generic conformance (type-level)', () => {
  it('DefaultTask satisfies TaskLike', () => {
    type _ok = DefaultTask extends TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId> ? true : never
    const witness: _ok = true
    expect(witness).toBe(true)
  })

  it('DefaultRevision satisfies RevisionLike', () => {
    type _ok = DefaultRevision extends RevisionLike<RevisionId, TaskId, ValueOrLink<DictAsset>> ? true : never
    const witness: _ok = true
    expect(witness).toBe(true)
  })

  it('DefaultAction satisfies ActionLike constraints (its task field is a TaskLike)', () => {
    type _ok = DefaultAction['task'] extends TaskLike<unknown, unknown, unknown, unknown> ? true : never
    const witness: _ok = true
    expect(witness).toBe(true)
  })

  it('a third-party Task shape with extra fields still satisfies TaskLike', () => {
    interface ThirdPartyTask extends TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId> {
      my_custom_field: string
      another_extra: number
    }
    type _ok = ThirdPartyTask extends TaskLike<TaskId, ActionId, ValueOrLink<DictAsset>, RevisionId> ? true : never
    const witness: _ok = true
    expect(witness).toBe(true)
  })
})

describe('NamespacedActionId', () => {
  it('matches the core: prefix at the type level', () => {
    const a: SystemActionId = 'core:define_action'
    expect(a).toBe('core:define_action')
  })

  it('a consumer can define their own namespaced prefix', () => {
    type ProxyAction = NamespacedActionId<'proxy'>
    const a: ProxyAction = 'proxy:llm_call'
    expect(a).toBe('proxy:llm_call')
  })
})

describe('isSystemAction', () => {
  it('accepts strings with the core: prefix', () => {
    expect(isSystemAction('core:define_action')).toBe(true)
    expect(isSystemAction('core:anything_else')).toBe(true)
  })

  it('rejects strings with other prefixes', () => {
    expect(isSystemAction('proxy:llm_call')).toBe(false)
    expect(isSystemAction('user_action_id')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isSystemAction(null)).toBe(false)
    expect(isSystemAction(undefined)).toBe(false)
    expect(isSystemAction(42)).toBe(false)
    expect(isSystemAction({})).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isSystemAction('')).toBe(false)
  })
})

describe('imports compile (smoke test)', () => {
  it('all primitive type aliases are importable', () => {
    // If any of these imports break, this whole file would fail to compile.
    const _typesReachable: [
      AssetId | undefined,
      TaskId | undefined,
      RevisionId | undefined,
      UserActionId | undefined,
      SystemActionId | undefined,
      ActionId | undefined,
      ActorId | undefined,
    ] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined]
    expect(_typesReachable.length).toBe(7)
  })
})
