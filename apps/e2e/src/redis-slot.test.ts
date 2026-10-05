import { describe, expect, it } from 'vitest'
import { isStaleClaim, withIndex } from './redis-slot'

const here = { host: 'laptop', processExists: (pid: number) => pid === 42 }
const claim = (value: object) => JSON.stringify(value)

describe('isStaleClaim', () => {
  it('is stale when the claiming process on this host is gone', () => {
    expect(isStaleClaim(claim({ pid: 7, host: 'laptop', startedAt: '2026-10-05T10:00:00Z' }), here)).toBe(true)
  })

  it('is not stale while the claiming process runs', () => {
    expect(isStaleClaim(claim({ pid: 42, host: 'laptop' }), here)).toBe(false)
  })

  it('never takes over a claim from another host, whose processes it cannot see', () => {
    expect(isStaleClaim(claim({ pid: 7, host: 'ci-runner' }), here)).toBe(false)
  })

  it('never takes over a value it does not understand', () => {
    for (const raw of ['', 'not json', claim({ host: 'laptop' }), claim({ pid: '7', host: 'laptop' })]) {
      expect(isStaleClaim(raw, here), raw).toBe(false)
    }
  })

  it('checks the real process table by default', () => {
    expect(isStaleClaim(claim({ pid: process.pid, host: 'unknown-host' }))).toBe(false)
  })
})

describe('withIndex', () => {
  it('replaces the database index and keeps the rest of the URL', () => {
    expect(withIndex('redis://:secret@localhost:6389/4', 15)).toBe('redis://:secret@localhost:6389/15')
    expect(withIndex('redis://localhost:6389', 9)).toBe('redis://localhost:6389/9')
  })
})
