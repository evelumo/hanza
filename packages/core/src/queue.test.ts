import { describe, expect, it } from 'vitest'
import { bullJobOptions, redisConnection } from './queue'

describe('redisConnection', () => {
  it('parses host, port, credentials and database', () => {
    expect(redisConnection('redis://user:p%40ss@redis.local:6390/2')).toMatchObject({
      host: 'redis.local',
      port: 6390,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: undefined,
    })
  })

  it('defaults the port and enables TLS for rediss://', () => {
    expect(redisConnection('rediss://cache.example.com')).toMatchObject({
      host: 'cache.example.com',
      port: 6379,
      tls: {},
    })
  })
})

describe('bullJobOptions', () => {
  it('maps coalesceKey to deduplication that keeps the last request while one is active', () => {
    expect(bullJobOptions({ coalesceKey: 'stock.push:c1', delayMs: 500 })).toEqual({
      deduplication: { id: 'stock.push:c1', keepLastIfActive: true },
      delay: 500,
    })
  })

  it('adds nothing without options', () => {
    expect(bullJobOptions()).toEqual({})
  })
})
