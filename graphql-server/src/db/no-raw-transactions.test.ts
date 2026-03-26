// Copyright (c) 2026 Wuji Labs Inc
/**
 * Enforcement test: no raw transaction SQL in the codebase.
 *
 * With better-sqlite3, all transactions are handled by db.transaction() via
 * the withTransaction() helper in mutation-serializer.ts. No code should
 * contain raw BEGIN/COMMIT/ROLLBACK SQL strings.
 */

import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

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
  it('no raw BEGIN/COMMIT/ROLLBACK SQL in source files', () => {
    const srcDir = path.resolve(__dirname, '..')
    const tsFiles = getAllTsFiles(srcDir)
    const violations: string[] = []

    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        if (/BEGIN\s+(TRANSACTION|IMMEDIATE)/i.test(line) || /\bCOMMIT\b/.test(line) || /\bROLLBACK\b/.test(line)) {
          const rel = path.relative(srcDir, file)
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
