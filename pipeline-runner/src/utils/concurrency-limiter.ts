// Copyright (c) 2026 Wuji Labs Inc
/**
 * Global Concurrency Limiter System
 *
 * Provides centralized concurrency control for different operation types
 * to prevent socket exhaustion and GraphQL request overload.
 */

import pLimit from 'p-limit'

// Global concurrency limits per operation type
// GraphQL operations use Apollo Client with 200 socket pool
// S3 operations use AWS SDK with separate socket pool (configured in asset-store)
const CONCURRENCY_LIMITS = {
  'workflow-orchestration': 50, // 25% of GraphQL socket capacity (200)
  'task-polling': 40, // 20% of GraphQL socket capacity
  'task-creation': 40, // 20% of GraphQL socket capacity
  'task-update': 40, // 20% of GraphQL socket capacity
  's3-store': 40, // S3 store() concurrency limit (separate socket pool)
  's3-load': 80, // S3 load() concurrency limit (higher since reads are more common)
  'default': 30, // 15% reserve capacity
} as const

// Type for valid limiter keys
export type LimiterKey = keyof typeof CONCURRENCY_LIMITS | 'default'

// Global registry of limiters
const limiters: Record<LimiterKey, ReturnType<typeof pLimit>> = {} as any

// Initialize all limiters
for (const [key, limit] of Object.entries(CONCURRENCY_LIMITS)) {
  limiters[key as LimiterKey] = pLimit(limit)
}

/**
 * Get a concurrency limiter for the specified operation type
 */
export function getLimiter(
  key: LimiterKey = 'default',
): ReturnType<typeof pLimit> {
  return limiters[key] || limiters.default
}

/**
 * Execute a function with concurrency limiting for the specified operation type
 */
export async function withLimit<T>(
  fn: () => Promise<T>,
  limiterKey: LimiterKey = 'default',
): Promise<T> {
  const limiter = getLimiter(limiterKey)
  return limiter(fn)
}

/**
 * Get current pending/active counts for monitoring
 */
export function getLimiterStats(): Record<
  LimiterKey,
  { activeCount: number, pendingCount: number }
> {
  const stats = {} as Record<
    LimiterKey,
    { activeCount: number, pendingCount: number }
  >

  for (const key of Object.keys(limiters) as LimiterKey[]) {
    const limiter = limiters[key]
    stats[key] = {
      activeCount: limiter.activeCount,
      pendingCount: limiter.pendingCount,
    }
  }

  return stats
}

/**
 * Log current limiter statistics for debugging
 */
export function logLimiterStats(): void {
  const stats = getLimiterStats()
  console.log('🚦 Concurrency Limiter Stats:', JSON.stringify(stats, null, 2))
}

/**
 * Configuration for debugging - can be adjusted at runtime
 */
export const LIMITER_CONFIG = {
  logInterval: 30000, // Log stats every 30 seconds
  warnThreshold: 0.8, // Warn when utilization > 80%
}

// Optional: Log stats periodically for monitoring
let logInterval: NodeJS.Timeout | null = null

export function enablePeriodicLogging(): void {
  if (logInterval) return // Already enabled

  logInterval = setInterval(() => {
    const stats = getLimiterStats()
    let shouldLog = false

    // Check if any limiter is above warning threshold
    for (const [key, { activeCount, pendingCount }] of Object.entries(stats)) {
      const limit = CONCURRENCY_LIMITS[key as LimiterKey]
      const utilization = activeCount / limit

      if (utilization > LIMITER_CONFIG.warnThreshold || pendingCount > 10) {
        shouldLog = true
        break
      }
    }

    if (shouldLog) {
      console.warn('⚠️  High concurrency limiter usage detected:')
      logLimiterStats()
    }
  }, LIMITER_CONFIG.logInterval)
}

export function disablePeriodicLogging(): void {
  if (logInterval) {
    clearInterval(logInterval)
    logInterval = null
  }
}

// Auto-enable periodic logging in production and for debugging
if (
  process.env.NODE_ENV === 'production'
  || process.env.DEBUG_CONCURRENCY === 'true'
) {
  enablePeriodicLogging()
}
