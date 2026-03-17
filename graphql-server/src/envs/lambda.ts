// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import {
  handlers,
  startServerAndCreateLambdaHandler,
} from '@as-integrations/aws-lambda'
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { parseUserContext } from '../auth/user.js'
import { createApolloServer } from '../server.js'

// Create Apollo Server instance for Lambda (no plugins needed)
const server = createApolloServer()

export const graphqlHandler: APIGatewayProxyHandlerV2
  = startServerAndCreateLambdaHandler(
    server as any,
    // We will be using the Proxy V2 handler
    handlers.createAPIGatewayProxyEventV2RequestHandler(),
    {
      context: async ({ event }) => {
        const ip
          = event.headers['x-forwarded-for']
            || event.requestContext.http.sourceIp
            || ''
        // console.log(event.requestContext.http.sourceIp);
        // console.log(event.headers);
        const token = event.headers.authorization || ''
        return parseUserContext(token, ip)
      },
    },
  )
