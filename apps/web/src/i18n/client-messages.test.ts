import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogues } from './catalogues'
import { clientMessages } from './client-messages'

const root = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx$/.test(name) ? [path] : []
  })
}

function lookup(node: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[part] : undefined), node)
}

// Components that run in the browser: marked 'use client', or rendered only below one that is (they call
// `useT` without a directive of their own).
const usedOnlyFromClient = ['connector-fields.tsx']

describe('clientMessages', () => {
  const files = sourceFiles(root).filter((file) => {
    const source = readFileSync(file, 'utf8')
    return source.includes('use-t') && (/^['"]use client['"]/m.test(source) || usedOnlyFromClient.some((name) => file.endsWith(name)))
  })

  it('finds the client components', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('carry every message key a client component spells out', () => {
    for (const locale of ['en', 'pl'] as const) {
      const sent = clientMessages(catalogues[locale])
      for (const file of files) {
        for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\(\s*['`]([\w.]+)['`]/g)) {
          expect(typeof lookup(sent, key as string), `${locale}: ${key} in ${file}`).toBe('string')
        }
      }
    }
  })

  it('carry the groups behind keys built at run time', () => {
    const sent = clientMessages(catalogues.en)
    for (const key of ['offers.skipReasons.no_sku', 'auth.errors.userExists', 'auth.register.failed', 'auth.onboarding.failed', 'nav.orders', 'common.saving']) {
      expect(typeof lookup(sent, key), key).toBe('string')
    }
  })

  it('leave the server-only groups out', () => {
    expect(Object.keys(clientMessages(catalogues.en))).not.toContain('labels')
  })
})
