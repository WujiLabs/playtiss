// Copyright (c) 2026 Wuji Labs Inc
/**
 * SQLite Event Consumer Implementation
 *
 * Consumes events from the EventLog table with crash recovery
 * via projection offsets (consumer bookmarks).
 */

import sqlite3 from 'sqlite3'
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
  private db: sqlite3.Database
  private lastProcessedEventId: string | null = null
  private initialized = false

  constructor(
    private dbPath: string,
    private projectionId: string,
    private topics: string[],
  ) {
    this.db = new sqlite3.Database(dbPath)
  }

  /**
   * Initialize the projection offset
   * Creates a new offset entry if none exists
   */
  private async initializeOffset(): Promise<void> {
    if (this.initialized) return

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT last_processed_event_id FROM ProjectionOffsets WHERE projection_id = ?`,
        [this.projectionId],
        (err, row: any) => {
          if (err) return reject(err)

          if (row) {
            // Existing offset found
            this.lastProcessedEventId = row.last_processed_event_id || ''
            console.log(
              `📖 Resuming from offset: ${this.lastProcessedEventId || '(beginning)'}`,
            )
            this.initialized = true
            resolve()
          }
          else {
            // Initialize new projection offset
            console.log(`📝 Initializing new projection: ${this.projectionId}`)
            this.db.run(
              `INSERT INTO ProjectionOffsets (projection_id, last_processed_event_id) VALUES (?, ?)`,
              [this.projectionId, ''],
              (err) => {
                if (err) return reject(err)
                this.lastProcessedEventId = ''
                this.initialized = true
                resolve()
              },
            )
          }
        },
      )
    })
  }

  /**
   * Poll for new events since last processed offset
   * Returns events in order (by event_id/TraceID)
   *
   * @param batchSize Maximum number of events to return
   * @returns Array of events (may be empty)
   */
  async poll(batchSize: number): Promise<Event[]> {
    // Ensure offset is initialized
    await this.initializeOffset()

    const placeholders = this.topics.map(() => '?').join(',')
    const query = `
      SELECT event_id, topic, payload, timestamp_created
      FROM EventLog
      WHERE topic IN (${placeholders})
        AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `

    return new Promise((resolve, reject) => {
      this.db.all(
        query,
        [...this.topics, this.lastProcessedEventId || '', batchSize],
        (err, rows: any[]) => {
          if (err) return reject(err)

          const events: Event[] = rows.map(row => ({
            id: row.event_id,
            topic: row.topic,
            payload: JSON.parse(row.payload),
            timestamp: row.timestamp_created,
          }))

          resolve(events)
        },
      )
    })
  }

  /**
   * Commit the processing offset to the given event
   * Updates the ProjectionOffsets table atomically
   *
   * @param event The event to mark as processed
   */
  async commit(event: Event): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE ProjectionOffsets SET last_processed_event_id = ? WHERE projection_id = ?`,
        [event.id, this.projectionId],
        (err) => {
          if (err) return reject(err)
          this.lastProcessedEventId = event.id
          resolve()
        },
      )
    })
  }

  /**
   * Close the subscription and database connection
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close(() => {
        console.log(`🔒 Closed event bus subscription: ${this.projectionId}`)
        resolve()
      })
    })
  }
}
