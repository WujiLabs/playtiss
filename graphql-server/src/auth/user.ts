// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
import { GraphQLError } from 'graphql'
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken'
import type { AssetId } from 'playtiss'
const { verify, sign } = jwt

// Phase 1 User and Context Simplification
export type Phase1User = {
  id: string // e.g., "mock-user-id"
  name: string // e.g., "Mock User"
  // Add any other fields needed for Phase 1, like a simple role
  isAdmin?: boolean
}

// export const setTokens = ({ id }) => {
//   // if you want to include more than the user's id in the JWT then include it here
//   const user = { user: { id } };
//   const accessToken = sign(user, process.env.ACCESS_TOKEN_SECRET, {
//     expiresIn: process.env.ACCESS_TOKEN_DURATION,
//   });
//   const refreshToken = sign(user, process.env.REFRESH_TOKEN_SECRET, {
//     expiresIn: process.env.REFRESH_TOKEN_DURATION,
//   });
//   return { id, accessToken, refreshToken };
// };

// the following two functions wrap verify() in a try/catch to muffle expired jwt errors
async function validateToken(
  token: string,
  secret: string,
): Promise<JwtPayload> {
  return new Promise<JwtPayload>((resolve, reject) => {
    verify(token, secret, { algorithms: ['HS256'] }, (err, payload) => {
      if (!err) {
        if (!!payload && typeof payload !== 'string') {
          resolve(payload)
        }
        else {
          reject('No valid payload')
        }
      }
      else {
        reject(err)
      }
    })
  })
}

async function generateToken(
  payload: JwtPayload,
  secret: string,
  options?: SignOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sign(
      payload,
      secret,
      { ...(options ?? {}), algorithm: 'HS256' },
      (err, token) => {
        if (!err) {
          if (!!token && typeof token === 'string') {
            resolve(token)
          }
          else {
            reject('No valid token')
          }
        }
        else {
          reject(err)
        }
      },
    )
  })
}

const TOKEN_PREFIX = 'Bearer ' // space separator
const JWT_SECRET = 'Yt2dEfdqrFz4g8rK'

export type ValidUserContext = {
  user: Phase1User // Changed from Creator
  // admin?: AssetId; // Removed admin AssetId concept for Phase 1 simplicity from context
}

export type InvalidUserContext = {
  user: null
  error: GraphQLError // Keep GraphQLError for errors
}

export type UserContext = ValidUserContext | InvalidUserContext
export type ExtendUserContext = UserContext & {
  ip: string
}

export async function parseUserContext(
  token: string,
  ip: string,
): Promise<ExtendUserContext> {
  if (!token || token === 'null' || token === 'undefined') {
    // Handle cases where token might be literal strings "null" or "undefined"
    token = '' // Treat as no token
  }

  if (!token.startsWith(TOKEN_PREFIX) && token !== 'mock-token') {
    // Allow "mock-token" to bypass prefix check
    return {
      user: null,
      error: new GraphQLError('Authorization token missing or malformed', {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
      }),
      ip,
    }
  }

  // Phase 1: If it's the mock token, return a mock user
  if (
    token === 'mock-token'
    || token.slice(TOKEN_PREFIX.length) === 'mock-token'
  ) {
    return {
      user: { id: 'mock-user-id', name: 'Mock User', isAdmin: true }, // Example mock user
      ip,
    }
  }

  // Keep JWT validation for non-mock tokens if they might exist, but simplify user hydration
  try {
    const jwtPayload = await validateToken(
      token.slice(TOKEN_PREFIX.length),
      JWT_SECRET,
    )
    if (typeof jwtPayload.sub === 'string') {
      // Simplified user object from JWT sub for Phase 1
      // In a real system, jwtPayload.sub might be a user ID to fetch from DB
      return {
        user: {
          id: jwtPayload.sub,
          name: jwtPayload.name || 'User ' + jwtPayload.sub,
          isAdmin: !!jwtPayload.admin,
        },
        ip,
      }
    }
  }
  catch (e) {
    console.log('Token validation error:', e)
    // Fall through to return unauthenticated error
  }

  return {
    user: null,
    error: new GraphQLError('User is not authenticated', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    }),
    ip,
  }
}

export function assertAuthenticatedContext(context: UserContext): true {
  if (context.user !== null) {
    return true
  }
  throw context.error // Error is already a GraphQLError
}

export function getContextUser(context: UserContext): Phase1User {
  // Return Phase1User
  const { user } = context
  if (user !== null) {
    return user
  }
  throw context.error
}

export function getContextMeta({
  ip,
}: ExtendUserContext): Record<string, string> | undefined {
  if (!ip) {
    return undefined
  }
  return {
    ip,
  }
}

export type AdminInfo = { user: Phase1User, isAdmin: boolean } // Use Phase1User

export function getContextAdmin(
  context: UserContext,
  actionId: AssetId, // actionId currently not used in Phase 1 simplified admin check
): AdminInfo {
  const user = getContextUser(context) // Throws if not authenticated
  return { user, isAdmin: !!user.isAdmin } // Simplified admin check for Phase 1
}

export async function signUserContext(
  context: ValidUserContext, // context.user is Phase1User
): Promise<string> {
  const user = getContextUser(context)
  const payload: JwtPayload = {
    sub: user.id, // Use Phase1User id
    name: user.name, // Optional: include name in JWT
    admin: !!user.isAdmin, // Include isAdmin status
  }
  // Removed: if ("admin" in context) { ... } as admin AssetId is removed from ValidUserContext
  return generateToken(payload, JWT_SECRET, { expiresIn: '1d' })
}
