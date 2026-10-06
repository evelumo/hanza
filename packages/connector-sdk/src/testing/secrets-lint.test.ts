import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertNoSecrets, findSecrets, lintFixtures, looksLikePesel } from './secrets-lint'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWxsZXItMSJ9.c2lnbmF0dXJlLWJ5dGVz'

const rules = (value: unknown, allow?: Array<string | RegExp>) => findSecrets(value, { allow }).map(({ path, rule }) => `${path} ${rule}`)

describe('findSecrets', () => {
  it('flags credentials wherever they are', () => {
    expect(
      rules({
        interactions: [
          {
            request: { url: 'https://api.example.test/x?access_token=abc123&page=1', headers: { authorization: 'Bearer abc', Cookie: 'sid=1' } },
            response: { headers: { 'set-cookie': 'sid=2' }, body: { json: { token: 'live', refresh_token: '', note: `Bearer abcdefgh12345678`, raw: JWT } } },
          },
        ],
        auth: 'Basic dXNlcjpwYXNzd29yZA==',
      }),
    ).toEqual([
      'interactions.0.request.url secret-value',
      'interactions.0.request.headers.authorization credential-header',
      'interactions.0.request.headers.Cookie credential-header',
      'interactions.0.response.headers.set-cookie credential-header',
      'interactions.0.response.body.json.token secret-value',
      'interactions.0.response.body.json.note bearer',
      'interactions.0.response.body.json.raw jwt',
      'auth basic',
    ])
  })

  it('flags personal data: real e-mails, phone numbers and PESEL numbers', () => {
    expect(
      rules({
        email: 'jan.kowalski@poczta.pl',
        note: 'call +48 600 100 200',
        buyer: { phoneNumber: '600100200', pesel: '44051401359', ids: [44051401359] },
        age: 44051401359,
      }),
    ).toEqual(['email email', 'note phone', 'buyer.phoneNumber phone', 'buyer.pesel pesel', 'age pesel'])
  })

  it('accepts placeholders, reserved domains and things that only look similar', () => {
    expect(
      rules({
        token: '[scrubbed]',
        url: 'https://api.example.test/x?access_token=%5Bscrubbed%5D',
        header: 'Bearer [scrubbed]',
        email: 'person-1@example.com',
        others: ['a@example.org', 'b@shop.test', 'c@mail.example'],
        phone: '+00000000001',
        offerId: '44051401359',
        order_id: 44051401359,
        id: 44051401359,
        notPesel: '10939293211',
        date: '2026-10-06T10:00:00Z',
        amount: '1234567.89',
        text: 'Basic shipping included',
        tokenType: 'Bearer',
      }),
    ).toEqual([])
  })

  it('skips what is allowed, by exact text or regex', () => {
    expect(rules({ a: 'support@realshop.pl', b: 'sales@realshop.pl', c: 'x@other.pl' }, ['support@realshop.pl', /^sales@/])).toEqual(['c email'])
  })

  it('never shows a whole value', () => {
    const [finding] = findSecrets({ token: 'live-secret-token-value' }, { file: 'x.json' })
    expect(finding).toEqual({ file: 'x.json', path: 'token', rule: 'secret-value', excerpt: 'live… (23 chars)' })
    expect(findSecrets({ token: 'short' })[0]!.excerpt).toBe('*****')
  })
})

describe('looksLikePesel', () => {
  it('needs a valid date and checksum', () => {
    expect(looksLikePesel('44051401359')).toBe(true)
    expect(looksLikePesel('02270803624')).toBe(true) // born in 2002: month + 20
    expect(looksLikePesel('44051401358')).toBe(false)
    expect(looksLikePesel('44151401353')).toBe(false)
    expect(looksLikePesel('4405140135')).toBe(false)
  })
})

describe('lintFixtures and assertNoSecrets', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hanza-lint-'))
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'clean.cassette.json'), JSON.stringify({ email: 'person-1@example.com' }))
    await writeFile(join(dir, 'nested', 'leak.json'), JSON.stringify({ orders: [{ buyer: { email: 'jan@firma.pl' } }] }))
    await writeFile(join(dir, 'notes.md'), 'jan@firma.pl is ignored: only JSON is linted')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lints every JSON file below a directory', async () => {
    const findings = await lintFixtures(dir)
    expect(findings.map(({ file, path, rule }) => [file, path, rule])).toEqual([[join(dir, 'nested', 'leak.json'), 'orders.0.buyer.email', 'email']])
    await expect(assertNoSecrets(dir)).rejects.toThrow(/leak\.json: orders\.0\.buyer\.email \[email\] jan@… \(12 chars\)/)
    await expect(assertNoSecrets(join(dir, 'clean.cassette.json'))).resolves.toBeUndefined()
    await expect(assertNoSecrets(dir, { allow: ['jan@firma.pl'] })).resolves.toBeUndefined()
  })

  it('takes an in-memory value too', async () => {
    await expect(assertNoSecrets({ raw: JWT })).rejects.toThrow('[jwt]')
  })
})
