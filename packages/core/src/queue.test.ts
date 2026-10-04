import { describe, expect, it } from 'vitest'
import { redisConnection } from './queue'

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
