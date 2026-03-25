// Copyright (c) 2026 Wuji Labs Inc
/**
 * SQLite Mutation Serializer
 *
 * Ensures only one write operation happens at a time to prevent:
 * - SQLITE_BUSY errors
 * - Transaction nesting issues
 * - Database lock conflicts
 *
 * This is SQLite-specific and can be removed when migrating to databases
 * that support true concurrent writes (MySQL, PostgreSQL).
 *
 * ## API
 * - `withTransaction(name, fn)` — serialized + transactional (common case)
 * - `serializeMutation(name, fn)` — serialized, no transaction (rare: mixed patterns)
 * - `runInTransaction(db, txnId, fn)` — bare transaction, no serialization
 *   (only inside an already-serialized context)
 *
 * All `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` MUST go through these helpers.
 * A grep-based test enforces this — see no-raw-transactions.test.ts.
 */

import type sqlite3 from 'sqlite3'
import { getDB } from '../db.js'

/**
 * Context passed to operations running inside a transaction.
 * Identical to InternalOperationContext in database-operations.ts.
 */
export interface TransactionContext {
  db: sqlite3.Database
  transactionId: string
}

export class MutationSerializer {
  private queue: Promise<unknown> = Promise.resolve()
  private operationCount = 0
  private readonly maxQueueSize = 100 // Prevent memory leaks

  /**
   * Serialize a mutation operation
   * Ensures operations execute one at a time in FIFO order
   */
  async serialize<T>(
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Check queue size to prevent memory leaks
    if (this.operationCount >= this.maxQueueSize) {
      throw new Error(
        `Mutation queue full (${this.maxQueueSize} operations). System overloaded.`,
      )
    }

    this.operationCount++

    const operationId = `${operationName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    console.log(
      `🔄 Queued mutation: ${operationId} (queue size: ${this.operationCount})`,
    )

    // Chain this operation after the current queue
    const promise = this.queue
      .then(async () => {
        console.log(`▶️  Executing mutation: ${operationId}`)
        const startTime = Date.now()

        try {
          const result = await operation()
          const duration = Date.now() - startTime
          console.log(`✅ Completed mutation: ${operationId} (${duration}ms)`)
          return result
        }
        catch (error) {
          const duration = Date.now() - startTime
          console.error(
            `❌ Failed mutation: ${operationId} (${duration}ms):`,
            error,
          )
          throw error
        }
      })
      .catch(async (error) => {
        // If previous operation failed, still execute this one
        console.log(
          `▶️  Executing mutation after error: ${operationId}`,
          error,
        )
        const startTime = Date.now()

        try {
          const result = await operation()
          const duration = Date.now() - startTime
          console.log(`✅ Completed mutation: ${operationId} (${duration}ms)`)
          return result
        }
        catch (newError) {
          const duration = Date.now() - startTime
          console.error(
            `❌ Failed mutation: ${operationId} (${duration}ms):`,
            newError,
          )
          throw newError
        }
      })
      .finally(() => {
        this.operationCount--
      })

    // Update the queue to this promise (but ignore its result for next operation)
    this.queue = promise.catch(() => {
      // Errors don't break the chain - next operation can still run
    })

    return promise
  }

  /**
   * Get current queue statistics
   */
  getStatistics() {
    return {
      queueSize: this.operationCount,
      maxQueueSize: this.maxQueueSize,
    }
  }

  /**
   * Wait for all queued operations to complete
   * Useful for graceful shutdown
   */
  async drain(): Promise<void> {
    console.log(
      `🔄 Draining mutation queue (${this.operationCount} operations)...`,
    )
    await this.queue.catch(() => {}) // Ignore errors, just wait
    console.log('✅ Mutation queue drained')
  }
}

// Global serializer instance
let globalSerializer: MutationSerializer | null = null

export function getMutationSerializer(): MutationSerializer {
  if (!globalSerializer) {
    globalSerializer = new MutationSerializer()
  }
  return globalSerializer
}

/**
 * Convenience function for serializing mutations
 */
export function serializeMutation<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  return getMutationSerializer().serialize(operationName, operation)
}

/**
 * Run a function inside BEGIN IMMEDIATE / COMMIT / ROLLBACK
 * WITHOUT serialization.
 *
 * @warning Only call this inside a `serializeMutation` context.
 * Calling it from unserialized code risks "cannot start a transaction
 * within a transaction" errors.
 */
export function runInTransaction<T>(
  db: sqlite3.Database,
  transactionId: string,
  fn: (ctx: TransactionContext) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE;', (beginErr) => {
        if (beginErr) return reject(beginErr)
        const ctx: TransactionContext = { db, transactionId }
        fn(ctx)
          .then((result) => {
            db.run('COMMIT;', (commitErr) => {
              if (commitErr) reject(commitErr)
              else resolve(result)
            })
          })
          .catch((error) => {
            db.run('ROLLBACK;', () => reject(error))
          })
      })
    })
  })
}

/**
 * Serialized + transactional execution. The common case for mutations.
 *
 * Combines `serializeMutation` (one-at-a-time queue) with
 * `runInTransaction` (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
 *
 * @warning Do NOT call `serializeMutation`, `withTransaction`, or any
 * `DatabaseOperations` method from inside `fn` — the queue will deadlock.
 * Use `InternalDatabaseOperations` methods instead (they don't serialize).
 */
export function withTransaction<T>(
  operationName: string,
  fn: (ctx: TransactionContext) => Promise<T>,
): Promise<T> {
  return serializeMutation(operationName, () => {
    const db = getDB()
    const transactionId
      = `${operationName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    return runInTransaction(db, transactionId, fn)
  })
}
