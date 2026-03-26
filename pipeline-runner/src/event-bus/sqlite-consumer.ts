// Copyright (c) 2026 Wuji Labs Inc
/**
 * SQLite Event Consumer Implementation
 *
 * Consumes events from the EventLog table with crash recovery
 * via projection offsets (consumer bookmarks).
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import Database from 'better-sqlite3'

import type {
  Event,
  IConsumerSubscription,
  IEventConsumer,
} from './interfaces.js'

/**
 * SQLite-based event consumer
 * Reads events from EventLog table and tracks offsets in ProjectionOffsets
 */
export class SqliteEventConsumer implements IEventConsumer {
  constructor(private dbPath: string) {}

  async subscribe(
    projectionId: string,
    topics: string[],
  ): Promise<IConsumerSubscription> {
    return new SqliteConsumerSubscription(this.dbPath, projectionId, topics)
  }
}

/**
 * SQLite-based consumer subscription
 * Manages polling and offset commits for a specific projection
 */
class SqliteConsumerSubscription implements IConsumerSubscription {
  private db: DatabaseType
  private lastProcessedEventId: string | null = null
  private initialized = false

  constructor(
    private dbPath: string,
    private projectionId: string,
    private topics: string[],
  ) {
    this.db = new Database(dbPath, { timeout: 30000 })
  }

  /**
   * Initialize the projection offset
   * Creates a new offset entry if none exists
   */
  private initializeOffset(): void {
    if (this.initialized) return

    const row = this.db.prepare(
      `SELECT last_processed_event_id FROM ProjectionOffsets WHERE projection_id = ?`,
    ).get(this.projectionId) as { last_processed_event_id: string } | undefined

    if (row) {
      this.lastProcessedEventId = row.last_processed_event_id || ''
      console.log(
        `📖 Resuming from offset: ${this.lastProcessedEventId || '(beginning)'}`,
      )
    }
    else {
      console.log(`📝 Initializing new projection: ${this.projectionId}`)
      this.db.prepare(
        `INSERT INTO ProjectionOffsets (projection_id, last_processed_event_id) VALUES (?, ?)`,
      ).run(this.projectionId, '')
      this.lastProcessedEventId = ''
    }

    this.initialized = true
  }

  /**
   * Poll for new events since last processed offset
   * Returns events in order (by event_id/TraceID)
   *
   * @param batchSize Maximum number of events to return
   * @returns Array of events (may be empty)
   */
  async poll(batchSize: number): Promise<Event[]> {
    this.initializeOffset()

    const placeholders = this.topics.map(() => '?').join(',')
    const query = `
      SELECT event_id, topic, payload, timestamp_created
      FROM EventLog
      WHERE topic IN (${placeholders})
        AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `

    const rows = this.db.prepare(query).all(
      ...this.topics,
      this.lastProcessedEventId || '',
      batchSize,
    ) as Array<{ event_id: string, topic: string, payload: string, timestamp_created: number }>

    return rows.map(row => ({
      id: row.event_id,
      topic: row.topic,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp_created,
    }))
  }

  /**
   * Commit the processing offset to the given event
   * Updates the ProjectionOffsets table atomically
   *
   * @param event The event to mark as processed
   */
  async commit(event: Event): Promise<void> {
    this.db.prepare(
      `UPDATE ProjectionOffsets SET last_processed_event_id = ? WHERE projection_id = ?`,
    ).run(event.id, this.projectionId)
    this.lastProcessedEventId = event.id
  }

  /**
   * Close the subscription and database connection
   */
  async close(): Promise<void> {
    this.db.close()
    console.log(`🔒 Closed event bus subscription: ${this.projectionId}`)
  }
}
