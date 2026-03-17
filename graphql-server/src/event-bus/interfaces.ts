// Copyright (c) 2026 Wuji Labs Inc
/**
 * Event Bus Interfaces
 *
 * Defines the core abstractions for the event-driven architecture.
 * These interfaces are backend-agnostic and can be implemented
 * with different storage backends (SQLite, Kafka, etc.)
 */

import type { Database as SQLiteDatabase } from 'sqlite3'

/**
 * Standard event structure
 * Uses TraceID for event ID to get timestamp, sortability, and audit trail
 */
export interface Event {
  id: string // Event ID (TraceID)
  topic: string // Event topic, e.g., "task_completed", "task_failed", "stale_update_revision_created"
  payload: object // Event-specific data
  timestamp: number // Milliseconds since epoch
}

/**
 * Event topics supported by the system
 */
export const EVENT_TOPICS = {
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  STALE_UPDATE_REVISION_CREATED: 'stale_update_revision_created',
} as const

/**
 * Producer interface (used by GraphQL Server)
 * Produces events atomically within database transactions
 */
export interface IEventProducer {
  /**
   * Produce an event
   * IMPORTANT: In SQLite implementation, this must be called within
   * the caller's database transaction to ensure atomicity
   *
   * @param topic Event topic
   * @param payload Event data
   * @param db Database instance (for SQLite backend)
   * @returns The created event
   */
  produce(topic: string, payload: object, db: SQLiteDatabase): Promise<Event>
}

/**
 * Consumer interface (used by Pipeline Runner)
 * Consumes events with crash recovery via projection offsets
 */
export interface IEventConsumer {
  /**
   * Subscribe to one or more event topics
   *
   * @param projectionId Unique ID for this consumer (used for bookmarking)
   *                     e.g., "WorkflowRevisionNodeStates_Updater"
   * @param topics List of topics to subscribe to
   * @returns A subscription for polling and committing events
   */
  subscribe(
    projectionId: string,
    topics: string[]
  ): Promise<IConsumerSubscription>
}

/**
 * Consumer subscription interface
 * Represents an active subscription with offset management
 */
export interface IConsumerSubscription {
  /**
   * Poll for the next batch of unprocessed events
   * Events are returned in order (by event_id/TraceID)
   *
   * @param batchSize Maximum number of events to return
   * @returns Array of events (may be empty if no new events)
   */
  poll(batchSize: number): Promise<Event[]>

  /**
   * Commit the processing offset to the given event
   * This enables crash recovery - after restart, polling will
   * resume from the last committed event
   *
   * IMPORTANT: Only commit after successfully processing the event
   *
   * @param event The event to mark as processed
   */
  commit(event: Event): Promise<void>

  /**
   * Close the subscription and release resources
   */
  close(): Promise<void>
}
