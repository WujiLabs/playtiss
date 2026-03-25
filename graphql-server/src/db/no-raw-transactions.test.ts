// Copyright (c) 2026 Wuji Labs Inc
/**
 * Enforcement test: all SQLite transactions MUST go through mutation-serializer.ts.
 *
 * Raw `BEGIN TRANSACTION` / `BEGIN IMMEDIATE` outside the serializer causes
 * "cannot start a transaction within a transaction" errors when concurrent
 * mutations overlap on the shared SQLite connection.
 *
 * Use `withTransaction()` or `serializeMutation()` + `runInTransaction()`.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function getAllTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...getAllTsFiles(fullPath))
    }
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath)
    }
  }
  return results
}

describe('Transaction safety enforcement', () => {
  it('no BEGIN TRANSACTION/IMMEDIATE outside mutation-serializer.ts', () => {
    const srcDir = path.resolve(__dirname, '..')
    const allowedFile = path.resolve(__dirname, 'mutation-serializer.ts')

    const tsFiles = getAllTsFiles(srcDir)
    const violations: string[] = []

    for (const file of tsFiles) {
      if (path.resolve(file) === allowedFile) continue

      const content = fs.readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        if (/BEGIN\s+(TRANSACTION|IMMEDIATE)/i.test(line)) {
          const rel = path.relative(srcDir, file)
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
