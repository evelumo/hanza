import { describe, expect, it } from 'vitest'
import type { CassetteInteraction } from './cassette'
import { scrubInteractions, Scrubber, SCRUBBED } from './scrub'
import { findSecrets } from './secrets-lint'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWxsZXItMSJ9.c2lnbmF0dXJlLWJ5dGVz'

function interaction(overrides: { request?: Partial<CassetteInteraction['request']>; response?: Partial<CassetteInteraction['response']> }): CassetteInteraction {
  return {
    request: { method: 'GET', url: 'https://api.example.test/orders', headers: {}, body: null, ...overrides.request },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: null, ...overrides.response },
  }
}

describe('headers', () => {
  it('keeps only accept and content-type on requests, and never credentials', () => {
    const [scrubbed] = scrubInteractions([
      interaction({
        request: {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${JWT}`,
            Cookie: 'session=abc',
            'User-Agent': 'Hanza/1.0',
            'X-Request-Id': '42',
          },
        },
        response: { headers: { 'content-type': 'application/json', 'set-cookie': 'session=def', 'retry-after': '30', date: 'Tue, 06 Oct 2026 10:00:00 GMT' } },
      }),
    ])
    expect(scrubbed!.request.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
    expect(scrubbed!.response.headers).toEqual({ 'content-type': 'application/json', 'retry-after': '30' })
  })

  it('keeps extra headers on request, scrubbed, but refuses to keep a credential header', () => {
    const scrubber = new Scrubber({ keepRequestHeaders: ['User-Agent', 'X-Debug'] })
    const { request } = scrubber.interaction(
      interaction({ request: { headers: { 'user-agent': 'Hanza/1.0', 'x-debug': `token=${JWT}` } } }),
    )
    expect(request.headers).toEqual({ 'user-agent': 'Hanza/1.0', 'x-debug': `token=${SCRUBBED}` })
    expect(() => new Scrubber({ keepRequestHeaders: ['Authorization'] })).toThrow(/authorization/)
    expect(() => new Scrubber({ keepResponseHeaders: ['Set-Cookie'] })).toThrow(/set-cookie/)
  })
})

describe('bodies', () => {
  it('replaces secret-named keys, Bearer and JWT strings, real e-mails and phone numbers anywhere', () => {
    const scrubber = new Scrubber()
    const json = scrubber.json(
      {
        access_token: 'live-access-token-1',
        refreshToken: 'live-refresh-token-1',
        nested: { 'client-secret': 'live-client-secret', note: `Call me with Bearer ${JWT}` },
        contact: 'Write to jan.kowalski@poczta.pl or call +48 600 100 200',
        safe: 'support@example.com',
        id: 12345678901,
      },
      [],
    )
    expect(json).toEqual({
      access_token: SCRUBBED,
      refreshToken: SCRUBBED,
      nested: { 'client-secret': SCRUBBED, note: `Call me with Bearer ${SCRUBBED}` },
      contact: 'Write to person-1@example.com or call +00000000001',
      safe: 'support@example.com',
      id: 12345678901,
    })
  })

  it('replaces declared keys and paths, whole subtrees included, with stable fakes', () => {
    const scrubber = new Scrubber({
      keys: { firstName: 'text', 'e_mail': 'email', pesel: 'text' },
      paths: { 'orders.buyer.address': 'text', 'orders.*.taxId': 'text' },
    })
    const json = scrubber.json(
      {
        orders: [
          { id: 'o-1', buyer: { firstName: 'Jan', e_mail: 'jan@firma.pl', pesel: '44051401359', address: { street: 'Długa 1', number: 5, gate: true } }, invoice: { taxId: '5260001246' } },
          { id: 'o-2', buyer: { firstName: 'Jan', e_mail: 'ola@firma.pl', pesel: null, address: null }, invoice: { taxId: null } },
        ],
      },
      [],
    )
    expect(json).toEqual({
      orders: [
        { id: 'o-1', buyer: { firstName: 'scrubbed-1', e_mail: 'person-1@example.com', pesel: 'scrubbed-2', address: { street: 'scrubbed-3', number: 0, gate: true } }, invoice: { taxId: 'scrubbed-4' } },
        { id: 'o-2', buyer: { firstName: 'scrubbed-1', e_mail: 'person-2@example.com', pesel: null, address: null }, invoice: { taxId: null } },
      ],
    })
  })

  it('applies connector patterns to every string', () => {
    const scrubber = new Scrubber({ patterns: [{ pattern: /\bPL\d{26}\b/, kind: 'text' }] })
    expect(scrubber.text('Pay to PL61109010140000071219812874 now')).toBe('Pay to scrubbed-1 now')
  })

  it('scrubs form bodies by parameter name and drops binary bodies unless kept', () => {
    const scrubber = new Scrubber({ queryParams: { username: 'text' } })
    const { request, response } = scrubber.interaction(
      interaction({
        request: {
          method: 'post',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: { text: 'grant_type=password&username=jan&password=hunter2hunter2' },
        },
        response: { headers: { 'content-type': 'application/pdf' }, body: { base64: 'JVBERi0xLjQ=' } },
      }),
    )
    expect(request.method).toBe('POST')
    expect(request.body).toEqual({ text: 'grant_type=password&username=scrubbed-1&password=%5Bscrubbed%5D' })
    expect(response.body).toBeNull()
    expect(new Scrubber({ keepBinaryBodies: true }).body({ base64: 'JVBERi0xLjQ=' }, 'application/pdf')).toEqual({ base64: 'JVBERi0xLjQ=' })
  })

  it('leaves text that only looks similar alone', () => {
    const scrubber = new Scrubber()
    const text = 'Basic shipping on 2026-10-06, order 10939293211, token count 3'
    expect(scrubber.text(text)).toBe(text)
  })
})

describe('URLs', () => {
  it('scrubs secret query parameters, credentials in the authority, the fragment and known secrets in the path', () => {
    const scrubber = new Scrubber({ queryParams: { buyerEmail: 'email' } }, ['live-webhook-secret'])
    expect(scrubber.url('https://user:pass@api.example.test/hooks/live-webhook-secret?access_token=abc123456&page=2&buyerEmail=jan%40firma.pl#top')).toBe(
      'https://api.example.test/hooks/[scrubbed]?access_token=%5Bscrubbed%5D&page=2&buyerEmail=person-1%40example.com',
    )
  })
})

describe('scrubInteractions', () => {
  it('learns a token from a later response and removes it from earlier interactions too', () => {
    const token = 'opaque-token-value-123'
    const scrubbed = scrubInteractions([
      interaction({ response: { body: { json: { next: `https://api.example.test/orders?page=2&t=${token}` } } } }),
      interaction({ request: { method: 'POST', url: 'https://api.example.test/token' }, response: { body: { json: { access_token: token } } } }),
    ])
    expect(JSON.stringify(scrubbed)).not.toContain(token)
    expect(findSecrets({ version: 1, interactions: scrubbed })).toEqual([])
  })

  it('removes the URL-encoded form of a known secret', () => {
    const secret = 'abc+def/ghi=jkl'
    const [scrubbed] = scrubInteractions(
      [interaction({ response: { body: { text: `signed with ${encodeURIComponent(secret)} and ${secret}` }, headers: { 'content-type': 'text/plain' } } })],
      {},
      [secret],
    )
    expect(scrubbed!.response.body).toEqual({ text: `signed with ${SCRUBBED} and ${SCRUBBED}` })
  })

  it('is idempotent: scrubbing a scrubbed recording changes nothing', () => {
    const config = { keys: { name: 'text' as const, email: 'email' as const, phone: 'phone' as const } }
    const once = scrubInteractions(
      [
        interaction({
          request: { url: `https://api.example.test/orders?access_token=${JWT}` },
          response: { body: { json: { name: 'Jan', email: 'jan@firma.pl', phone: '600100200', note: `Bearer ${JWT}` } } },
        }),
      ],
      config,
    )
    expect(scrubInteractions(once, config)).toEqual(once)
  })

  it('numbers fakes from the start of the recording, so a re-recording of the same data gives the same file', () => {
    const recording = [interaction({ response: { body: { json: { a: 'x@firma.pl', b: 'y@firma.pl', c: 'x@firma.pl' } } } })]
    expect(scrubInteractions(recording)).toEqual(scrubInteractions(recording))
    expect(scrubInteractions(recording)[0]!.response.body).toEqual({
      json: { a: 'person-1@example.com', b: 'person-2@example.com', c: 'person-1@example.com' },
    })
  })
})
