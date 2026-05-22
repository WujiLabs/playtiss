// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { computeHash } from '../hash.js'
import type { ActionId, TaskId, TaskInput } from './types.js'

/**
 * Compute the content-hashed {@link TaskId} for an (action, input) pair via
 * `computeHash`. Same inputs → same TaskId across processes / machines (L2.1
 * referential transparency).
 *
 * Async because `computeHash` is async (Web Crypto / multiformats). Tasks
 * register at startup, so this is paid once at boot — never on the per-emit
 * hot path.
 *
 * Note: input field ordering doesn't matter — `computeHash` uses dag-json
 * canonicalization which sorts object keys by UTF-8 byte order.
 */
export async function applyTask(
  action: ActionId,
  input: TaskInput,
): Promise<TaskId> {
  return computeHash({ action, input: input as Record<string, unknown> })
}
