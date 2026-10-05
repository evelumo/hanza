import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadEnv } from './env'

const base = { DATABASE_URL: 'postgresql://localhost:5432/hanza', REDIS_URL: 'redis://localhost:6379' }

describe('loadEnv', () => {
  it('accepts a base64 key of exactly 32 bytes', () => {
    const key = randomBytes(32).toString('base64')
    expect(loadEnv({ ...base, HANZA_ENCRYPTION_KEY: key }).HANZA_ENCRYPTION_KEY).toBe(key)
  })

  it('accepts the dummy CI key', () => {
    expect(() => loadEnv({ ...base, HANZA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).not.toThrow()
  })

  it.each([31, 33])('rejects a key of %i bytes', (length) => {
    expect(() => loadEnv({ ...base, HANZA_ENCRYPTION_KEY: randomBytes(length).toString('base64') })).toThrow(/HANZA_ENCRYPTION_KEY/)
  })

  it('rejects a missing key', () => {
    expect(() => loadEnv(base)).toThrow(/HANZA_ENCRYPTION_KEY/)
  })
})
