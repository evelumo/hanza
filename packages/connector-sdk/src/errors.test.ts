import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthExpiredError,
  ConnectorError,
  PermanentError,
  RateLimitedError,
  TransientError,
  classifyConnectorError,
  errorFromResponse,
  retryAfterFromHeaders,
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

  it('maps 401 to AuthExpiredError', async () => {
    expect(await respond(401, 'Unauthorized')).toBeInstanceOf(AuthExpiredError)
  })

  it('maps a 403 without an auth signal to PermanentError: no right to this resource, not a dead sign-in', async () => {
    const error = await respond(403, 'Forbidden')
    expect(error).toBeInstanceOf(PermanentError)
    expect(error.message).toBe('403 Forbidden')
  })

  it.each([
    'Bearer error="invalid_token", error_description="The access token expired"',
    'Bearer realm="api", error=invalid_token',
  ])('maps a 403 with WWW-Authenticate "%s" to AuthExpiredError', async (header) => {
    expect(await respond(403, 'Forbidden', { 'WWW-Authenticate': header })).toBeInstanceOf(AuthExpiredError)
  })

  it('asks the connector predicate, which may read the body, and never puts the body in the message', async () => {
    const isAuthFailure = async (response: Response) => ((await response.json()) as { error?: string }).error === 'invalid_grant'
    const refused = await errorFromResponse(new Response('{"error":"invalid_grant"}', { status: 400, statusText: 'Bad Request' }), {
      isAuthFailure,
    })
    expect(refused).toBeInstanceOf(AuthExpiredError)
    expect(refused.message).toBe('400 Bad Request')
    const other = await errorFromResponse(new Response('{"error":"invalid_request"}', { status: 400 }), { isAuthFailure })
    expect(other).toBeInstanceOf(PermanentError)
    const forbidden = await errorFromResponse(new Response(null, { status: 403 }), { isAuthFailure: (r) => r.status === 403 })
    expect(forbidden).toBeInstanceOf(AuthExpiredError)
  })

  it('falls back to the status when the predicate throws', async () => {
    const error = await errorFromResponse(new Response('not json', { status: 403 }), {
      isAuthFailure: async (response) => Boolean(await response.json()),
    })
    expect(error).toBeInstanceOf(PermanentError)
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

  it('reads decimal seconds in Retry-After', async () => {
    expect(((await respond(429, '', { 'Retry-After': '7.5' })) as RateLimitedError).retryAfterMs).toBe(7500)
  })

  it.each(['-1', '', '1e3', 'Tue, 6 Oct 2026'])('defaults to 60 s for the unreadable Retry-After "%s"', async (value) => {
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

describe('retryAfterFromHeaders', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const read = (headers: Record<string, string>) => retryAfterFromHeaders(new Headers(headers), now)

  it('prefers Retry-After, in seconds or as an HTTP date', () => {
    expect(read({ 'Retry-After': '3', 'X-RateLimit-Reset': '50' })).toBe(3000)
    expect(read({ 'Retry-After': 'Tue, 06 Oct 2026 12:00:30 GMT' })).toBe(30_000)
    expect(read({ 'Retry-After': 'Tue, 06 Oct 2026 11:59:00 GMT' })).toBe(0)
  })

  it('falls back to RateLimit-Reset, then X-RateLimit-Reset, as a delay or a Unix time', () => {
    expect(read({ 'RateLimit-Reset': '12' })).toBe(12_000)
    expect(read({ 'Retry-After': 'soon', 'X-RateLimit-Reset': '0.25' })).toBe(250)
    expect(read({ 'X-RateLimit-Reset': String(now / 1000 + 45) })).toBe(45_000)
    expect(read({ 'X-RateLimit-Reset': String(now / 1000 - 45) })).toBe(0)
  })

  it('returns null when nothing is readable', () => {
    expect(read({})).toBeNull()
    expect(read({ 'Retry-After': 'later', 'RateLimit-Reset': 'Tue, 06 Oct 2026 12:00:30 GMT' })).toBeNull()
  })
})
