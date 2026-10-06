import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthExpiredError,
  ConnectorError,
  CursorExpiredError,
  PermanentError,
  RateLimitedError,
  TransientError,
  classifyConnectorError,
  errorFromResponse,
  isCursorExpiredError,
} from './errors'

describe('error classes', () => {
  it('carry their kind and cause', () => {
    const cause = new Error('boom')
    expect(new AuthExpiredError('x').kind).toBe('auth_expired')
    expect(new TransientError('x', { cause }).cause).toBe(cause)
    expect(new PermanentError('x').kind).toBe('permanent')
    const limited = new RateLimitedError('x', { retryAfterMs: 5 })
    expect(limited.kind).toBe('rate_limited')
    expect(limited.retryAfterMs).toBe(5)
    expect(limited).toBeInstanceOf(ConnectorError)
  })
})

describe('CursorExpiredError', () => {
  it('is a PermanentError, so anywhere but a pull with a cursor it stops the run like one', () => {
    const error = new CursorExpiredError('older than the journal')
    expect(error).toBeInstanceOf(PermanentError)
    expect(classifyConnectorError(error)).toEqual({ kind: 'permanent', retryAfterMs: null, message: 'older than the journal' })
  })

  it('is recognised by instanceof and by shape (a second copy of the SDK), and nothing else is', () => {
    expect(isCursorExpiredError(new CursorExpiredError('x'))).toBe(true)
    expect(isCursorExpiredError({ name: 'CursorExpiredError', kind: 'permanent', cursorExpired: true, message: 'x' })).toBe(true)
    expect(isCursorExpiredError(new PermanentError('x'))).toBe(false)
    expect(isCursorExpiredError({ name: 'CursorExpiredError', kind: 'transient', cursorExpired: true })).toBe(false)
    expect(isCursorExpiredError({ name: 'PermanentError', kind: 'permanent', cursorExpired: true })).toBe(false)
    expect(isCursorExpiredError(null)).toBe(false)
    expect(isCursorExpiredError('CursorExpiredError')).toBe(false)
  })
})

describe('classifyConnectorError', () => {
  it.each([
    [new AuthExpiredError('a'), 'auth_expired'],
    [new TransientError('a'), 'transient'],
    [new PermanentError('a'), 'permanent'],
  ] as const)('keeps the kind of %s', (error, kind) => {
    expect(classifyConnectorError(error)).toEqual({ kind, retryAfterMs: null, message: 'a' })
  })

  it('returns retryAfterMs for rate limits', () => {
    expect(classifyConnectorError(new RateLimitedError('slow', { retryAfterMs: 2500 }))).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 2500,
      message: 'slow',
    })
  })

  it('recognises a ConnectorError from another copy of the module by shape', () => {
    const foreign = Object.assign(new Error('nope'), { name: 'AuthExpiredError', kind: 'auth_expired' })
    expect(classifyConnectorError(foreign).kind).toBe('auth_expired')
    const lookalike = Object.assign(new Error('nope'), { name: 'Boom', kind: 'auth_expired' })
    expect(classifyConnectorError(lookalike).kind).toBe('transient')
  })

  it('treats a ZodError as permanent', () => {
    const result = z.string().safeParse(1)
    expect(classifyConnectorError(result.error).kind).toBe('permanent')
  })

  it('treats fetch failures, aborts, timeouts and anything else as transient', () => {
    expect(classifyConnectorError(new TypeError('fetch failed')).kind).toBe('transient')
    expect(classifyConnectorError(new DOMException('aborted', 'AbortError')).kind).toBe('transient')
    expect(classifyConnectorError(new DOMException('timed out', 'TimeoutError')).kind).toBe('transient')
    expect(classifyConnectorError(new Error('weird'))).toEqual({ kind: 'transient', retryAfterMs: null, message: 'weird' })
    expect(classifyConnectorError('a string')).toEqual({ kind: 'transient', retryAfterMs: null, message: 'a string' })
  })

  it('truncates the message to 1000 characters', () => {
    expect(classifyConnectorError(new Error('x'.repeat(5000))).message).toHaveLength(1000)
  })
})

describe('errorFromResponse', () => {
  const respond = (status: number, statusText = '', headers: Record<string, string> = {}) =>
    errorFromResponse(new Response('secret body', { status, statusText, headers }))

  it.each([401, 403])('maps %i to AuthExpiredError', async (status) => {
    expect(await respond(status)).toBeInstanceOf(AuthExpiredError)
  })

  it.each([408, 500, 502, 503])('maps %i to TransientError', async (status) => {
    expect(await respond(status)).toBeInstanceOf(TransientError)
  })

  it.each([400, 404, 409, 422])('maps %i to PermanentError', async (status) => {
    expect(await respond(status)).toBeInstanceOf(PermanentError)
  })

  it('reads Retry-After in seconds', async () => {
    const error = await respond(429, 'Too Many Requests', { 'Retry-After': '7' })
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).retryAfterMs).toBe(7000)
  })

  it('reads Retry-After as an HTTP date', async () => {
    const date = new Date(Date.now() + 30_000).toUTCString()
    const error = (await respond(429, '', { 'Retry-After': date })) as RateLimitedError
    expect(error.retryAfterMs).toBeGreaterThan(25_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(30_000)
  })

  it.each(['7.5', '1.5', '-1', ''])('defaults to 60 s for the non-seconds, non-date Retry-After "%s"', async (value) => {
    expect(((await respond(429, '', { 'Retry-After': value })) as RateLimitedError).retryAfterMs).toBe(60_000)
  })

  it('defaults to 60 s when Retry-After is missing or unreadable', async () => {
    expect(((await respond(429)) as RateLimitedError).retryAfterMs).toBe(60_000)
    expect(((await respond(429, '', { 'Retry-After': 'soon' })) as RateLimitedError).retryAfterMs).toBe(60_000)
  })

  it('uses status and status text, never the body', async () => {
    const error = await respond(404, 'Not Found')
    expect(error.message).toBe('404 Not Found')
    expect(error.message).not.toContain('secret')
  })
})
