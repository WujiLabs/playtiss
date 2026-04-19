// Copyright (c) 2026 Wuji Labs Inc
/**
 * SQLite Event Producer Implementation
 *
 * Produces events atomically within database transactions.
 * Events are stored in the EventLog table with TraceID as primary key.
 */

import { generateTraceId } from '@playtiss/core'
import type { Database } from 'better-sqlite3'

import type { Event, IEventProducer } from './interfaces.js'

/**
 * SQLite-based event producer
 * Inserts events into EventLog table within the caller's transaction
 */
export class SqliteEventProducer implements IEventProducer {
  /**
   * Produce an event atomically within a database transaction
   *
   * IMPORTANT: This method must be called within an active database transaction
   * to ensure atomicity with other database operations (e.g., state updates)
   *
   * @param topic Event topic (e.g., "task_completed")
   * @param payload Event data (will be JSON-stringified)
   * @param db better-sqlite3 database instance
   * @returns The created event
   */
  produce(
    topic: string,
    payload: object,
    db: Database,
  ): Event {
    // Generate TraceID for event (provides timestamp, sortability, audit trail)
    const event: Event = {
      id: generateTraceId(),
      topic,
      payload,
      timestamp: Date.now(),
    }

    // Insert event into EventLog table
    // This will be part of the caller's transaction
    db.prepare(
      `INSERT INTO EventLog (event_id, topic, payload, timestamp_created) VALUES (?, ?, ?, ?)`,
    ).run(event.id, event.topic, JSON.stringify(event.payload), event.timestamp)

    return event
  }
}
