// Copyright (c) 2026 Wuji Labs Inc
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { expressMiddleware } from '@as-integrations/express5'
import cors from 'cors'
import { config } from 'dotenv'
import express from 'express'
import http from 'http'
import { shutdownDB } from '../db.js'
import { createApolloServer } from '../server.js'

// Load environment variables
config()

// Create Express app
const app = express()
const httpServer = http.createServer(app)

// Create Apollo Server with drain plugin for proper shutdown
const server = createApolloServer([
  ApolloServerPluginDrainHttpServer({
    httpServer,
    stopGracePeriodMillis: 2000, // Only wait 2 seconds for ongoing requests
  }),
])

// Start Apollo Server
await server.start()

// Apply middleware
app.use(
  '/',
  cors(),
  express.json(),
  expressMiddleware(server),
)

// Start HTTP server
await new Promise<void>((resolve) => {
  httpServer.listen({ port: 4000 }, resolve)
})

console.log(`🚀  Server ready at: http://localhost:4000/`)

// Flag to prevent multiple shutdowns
let isShuttingDown = false

// Graceful shutdown handling with timeout
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...')
    return
  }

  isShuttingDown = true
  console.log(`\n📊 Received ${signal}, starting graceful shutdown...`)

  // Set up a timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    console.log('⏰ Graceful shutdown timeout - forcing exit')
    process.exit(1)
  }, 10000) // 10 second timeout

  try {
    console.log('🔄 Closing HTTP server first...')
    // Close HTTP server first to stop accepting new connections
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('HTTP server close timeout'))
      }, 3000)

      httpServer.close((err) => {
        clearTimeout(timeout)
        if (err) {
          console.log('❌ HTTP server close error:', err)
          reject(err)
        }
        else {
          console.log('✅ HTTP server closed')
          resolve()
        }
      })
    })

    console.log('🔄 Stopping Apollo Server...')
    // Now stop Apollo Server (should be faster since no new connections)
    try {
      await Promise.race([
        server.stop(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Apollo Server stop timeout')),
            3000,
          ),
        ),
      ])
      console.log('✅ Apollo Server stopped')
    }
    catch {
      console.log('⚠️ Apollo Server stop timeout, continuing with shutdown...')
    }

    console.log('🔄 Shutting down database...')
    // Checkpoint and close database
    await shutdownDB()
    console.log('✅ Database shutdown completed')

    console.log('👋 Graceful shutdown completed')
    clearTimeout(forceExitTimeout)
    process.exit(0)
  }
  catch (error) {
    console.error('❌ Error during shutdown:', error)
    console.error(
      'Error stack:',
      error instanceof Error ? error.stack : 'Unknown error',
    )
    clearTimeout(forceExitTimeout)
    process.exit(1)
  }
}

// Handle shutdown signals
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(console.error)
})

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(console.error)
})

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error)
  try {
    await shutdownDB()
  }
  catch (shutdownError) {
    console.error('❌ Error during emergency shutdown:', shutdownError)
  }
  process.exit(1)
})

process.on('unhandledRejection', async (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
  try {
    await shutdownDB()
  }
  catch (shutdownError) {
    console.error('❌ Error during emergency shutdown:', shutdownError)
  }
  process.exit(1)
})
