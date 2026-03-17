// Copyright (c) 2026 Wuji Labs Inc
/**
 * Enhanced promise_map with Global Concurrency Limiting
 *
 * Drop-in replacement for playtiss/utils/promise_map that respects
 * global concurrency limits to prevent socket exhaustion.
 */

import promise_map from 'playtiss/utils/promise_map'
import { getLimiter, type LimiterKey } from './concurrency-limiter.js'

export interface LimitedPromiseMapOptions {
  concurrency?: number
  limiterKey?: LimiterKey
}

/**
 * Enhanced promise_map with global concurrency limiting
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item (matches promise_map signature with index)
 * @param options - Configuration options
 * @returns Promise resolving to array of results
 */
export async function promise_map_limited<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  options: LimitedPromiseMapOptions = {},
): Promise<R[]> {
  const { concurrency = 3, limiterKey = 'default' } = options
  const limiter = getLimiter(limiterKey)

  // Wrap the mapper with the global limiter (preserve index parameter)
  const limitedMapper = async (item: T, index: number): Promise<R> => {
    return limiter(() => mapper(item, index))
  }

  // Use the original promise_map with limited mapper
  // Note: We still pass concurrency to promise_map for internal batching,
  // but the actual concurrency is controlled by the global limiter
  return promise_map(items, limitedMapper, { concurrency })
}

/**
 * Backward-compatible wrapper that maintains the original promise_map signature
 * while adding optional limiter support
 */
export async function promise_map_with_limiter<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  options: { concurrency?: number } | LimitedPromiseMapOptions = {},
): Promise<R[]> {
  // Handle both old and new option formats
  const concurrency
    = typeof options === 'object' && 'concurrency' in options
      ? options.concurrency
      : 3
  const limiterKey = 'limiterKey' in options ? options.limiterKey : 'default'

  return promise_map_limited(items, mapper, { concurrency, limiterKey })
}

/**
 * Helper function to create operation-specific promise_map functions
 */
export function createLimitedPromiseMap(limiterKey: LimiterKey) {
  return async function <T, R>(
    items: T[],
    mapper: (item: T, index: number) => Promise<R>,
    options: { concurrency?: number } = {},
  ): Promise<R[]> {
    return promise_map_limited(items, mapper, {
      concurrency: options.concurrency,
      limiterKey,
    })
  }
}

// Pre-configured promise_map functions for common operations
export const workflowPromiseMap = createLimitedPromiseMap(
  'workflow-orchestration',
)
export const taskPollingPromiseMap = createLimitedPromiseMap('task-polling')
export const taskCreationPromiseMap = createLimitedPromiseMap('task-creation')
export const taskUpdatePromiseMap = createLimitedPromiseMap('task-update')
