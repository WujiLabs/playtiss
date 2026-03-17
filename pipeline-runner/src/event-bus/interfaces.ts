// Copyright (c) 2026 Wuji Labs Inc
/**
 * Event Bus Interfaces for Pipeline Runner
 *
 * These interfaces mirror the GraphQL server event bus interfaces
 * to ensure compatibility across the system.
 */

/**
 * Standard event structure
 * Uses TraceID for event ID to get timestamp, sortability, and audit trail
 */
export interface Event {
  id: string // Event ID (TraceID)
  topic: string // Event topic, e.g., "task_completed", "task_failed"
  payload: object // Event-specific data
  timestamp: number // Milliseconds since epoch
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
