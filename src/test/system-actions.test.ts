// Copyright (c) 2026 Wuji Labs Inc
import { isSystemAction } from '@playtiss/core'
import { describe, expect, it } from 'vitest'

import {
  actionIdToDbFormat,
  dbFormatToActionId,
  default_scope_id,
  getSystemAction,
  getSystemActionDefinitions,
  SYSTEM_ACTIONS,
} from '../system-actions.js'

describe('SYSTEM_ACTIONS registry', () => {
  it('CORE_DEFINE_ACTION is defined and has the core: prefix', () => {
    expect(SYSTEM_ACTIONS.CORE_DEFINE_ACTION).toBe('core:define_action')
    expect(isSystemAction(SYSTEM_ACTIONS.CORE_DEFINE_ACTION)).toBe(true)
  })

  it('CORE_ORCHESTRATE_UPDATE_STALE is defined and has the core: prefix', () => {
    expect(SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE).toBe('core:orchestrate_update_stale')
    expect(isSystemAction(SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE)).toBe(true)
  })

  it('lazy-init: consecutive reads return the same reference', () => {
    const a = SYSTEM_ACTIONS.CORE_DEFINE_ACTION
    const b = SYSTEM_ACTIONS.CORE_DEFINE_ACTION
    expect(a).toBe(b)
  })
})

describe('getSystemActionDefinitions', () => {
  it('contains entries for both built-in ids', () => {
    const defs = getSystemActionDefinitions()
    expect(defs[SYSTEM_ACTIONS.CORE_DEFINE_ACTION]).toBeDefined()
    expect(defs[SYSTEM_ACTIONS.CORE_ORCHESTRATE_UPDATE_STALE]).toBeDefined()
  })

  it('every definition has a non-empty input_schema and output_schema', () => {
    const defs = getSystemActionDefinitions()
    for (const def of Object.values(defs)) {
      expect(def.input_schema).toBeDefined()
      expect(def.output_schema).toBeDefined()
      expect(typeof def.name).toBe('string')
      expect(def.name.length).toBeGreaterThan(0)
    }
  })

  it('returns the same object on repeated calls (lazy cache)', () => {
    expect(getSystemActionDefinitions()).toBe(getSystemActionDefinitions())
  })
})

describe('getSystemAction', () => {
  it('returns a definition for a known id', () => {
    const def = getSystemAction(SYSTEM_ACTIONS.CORE_DEFINE_ACTION)
    expect(def).not.toBeNull()
    expect(def?.id).toBe(SYSTEM_ACTIONS.CORE_DEFINE_ACTION)
  })

  it('returns null for an unknown id', () => {
    expect(getSystemAction('core:unknown' as typeof SYSTEM_ACTIONS.CORE_DEFINE_ACTION)).toBeNull()
  })
})

describe('actionIdToDbFormat / dbFormatToActionId', () => {
  it('roundtrips a system action id', () => {
    const id = SYSTEM_ACTIONS.CORE_DEFINE_ACTION
    expect(dbFormatToActionId(actionIdToDbFormat(id))).toBe(id)
  })

  it('roundtrips an arbitrary string id', () => {
    const s = '019d9f37-9321-85a2-8bcc-23dd72000001'
    expect(actionIdToDbFormat(dbFormatToActionId(s))).toBe(s)
  })
})

describe('default_scope_id', () => {
  it('is "default"', () => {
    expect(default_scope_id).toBe('default')
  })
})
