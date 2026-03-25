// Copyright (c) 2026 Wuji Labs Inc
import {
  handlers,
  startServerAndCreateLambdaHandler,
} from '@as-integrations/aws-lambda'
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { createApolloServer } from '../server.js'

// Create Apollo Server instance for Lambda (no plugins needed)
const server = createApolloServer()

export const graphqlHandler: APIGatewayProxyHandlerV2
  = startServerAndCreateLambdaHandler(
    server as any,
    handlers.createAPIGatewayProxyEventV2RequestHandler(),
  )
