import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiUrl } from './client'
import { configSchema, credentialsSchema } from './settings'
import { RECORDING_STORE_URL } from './testing/recording'

describe('configSchema', () => {
  it.each([
    'https://shop.example.test',
    'https://shop.example.test/',
    'https://example.test/sklep',
    'https://shop.example.test:8443/sklep/',
    '  https://shop.example.test  ',
    'https://shop.example.com',
    'https://www.shop.example.co.uk/',
    'https://example.com:443',
    'https://example.com:65535/',
    'HTTPS://Shop.Example.COM',
    // A name that is one with the dot of the root at its end.
    'https://shop.example.com.',
    // International names, written out or already in their ASCII form.
    'https://sklep.żółw.pl',
    'https://xn--w-uga1v8h.pl/sklep',
    'https://例え.jp',
    // Numbers in a name are not an address.
    'https://1.2.3.4.example.com',
    'https://shop123.example.com',
    'https://123.pl',
    // These only look like the private names.
    'https://local.example.com',
    'https://localhost.example.com',
    'https://internal.example.com',
    'https://mylocal.pl',
    'https://shop.locals',
    'https://example.arpa',
  ])('accepts %j', (storeUrl) => {
    expect(configSchema.parse({ storeUrl })).toEqual({ storeUrl: storeUrl.trim() })
  })

  it('accepts the address the cassettes are recorded under', () => {
    expect(configSchema.safeParse({ storeUrl: RECORDING_STORE_URL }).success).toBe(true)
  })

  it.each([
    ['plain HTTP', 'http://shop.example.test'],
    ['a user name and password', 'https://admin:hunter22@shop.example.test'],
    ['a user name', 'https://admin@shop.example.test'],
    ['a query', 'https://shop.example.test/?rest_route=/'],
    ['a fragment', 'https://shop.example.test/#top'],
    ['no scheme', 'shop.example.test'],
    ['another scheme', 'ftp://shop.example.test'],
    ['nothing', ''],
    ['only a scheme', 'https://'],
    ['a scheme without its slashes', 'https:shop.example.test'],
    ['a scheme with one slash', 'https:/shop.example.test'],
    ['a space in it', 'https://shop.example.test/my shop'],
    ['a tab in it', 'https://shop.exa\tmple.test'],
    ['a line break in it', 'https://shop.example.test/\nx'],
    ['a backslash, which the parser reads as a slash', 'https://shop.example.test\\@evil.example.com'],
    ['an address longer than any', `https://shop.example.test/${'a'.repeat(2000)}`],
  ])('refuses %s', (_, storeUrl) => {
    expect(configSchema.safeParse({ storeUrl }).success).toBe(false)
  })

  // The parser reports no query and no fragment for these, and adding the API path to the text would have sent the
  // key to the front page: https://shop.example.test/?/wp-json/wc/v3/orders
  it.each([
    'https://shop.example.test/?',
    'https://shop.example.test?',
    'https://shop.example.test/#',
    'https://shop.example.test#',
    'https://shop.example.test/sklep/?',
    'https://shop.example.test/sklep?#',
  ])('refuses %j: an empty query or fragment is one too', (storeUrl) => {
    expect(configSchema.safeParse({ storeUrl }).success).toBe(false)
    // And if one were stored, the request would still go to the API.
    expect(apiUrl(storeUrl, 'orders').pathname).toMatch(/\/wp-json\/wc\/v3\/orders$/)
  })

  it.each(['https://shop.example.test:0', 'https://shop.example.test:0/sklep', 'https://shop.example.test:00', 'https://shop.example.test:65536', 'https://shop.example.test:https'])(
    'refuses the port of %j',
    (storeUrl) => {
      expect(configSchema.safeParse({ storeUrl }).success).toBe(false)
    },
  )

  it.each([
    // IPv4, however it is written: the parser turns each of these into four numbers.
    ['an IPv4 address', 'https://192.168.1.10'],
    ['a public IPv4 address', 'https://93.184.216.34/sklep'],
    ['the loopback address', 'https://127.0.0.1:8443'],
    ['the cloud metadata address', 'https://169.254.169.254'],
    ['an IPv4 address as one number', 'https://2130706433'],
    ['an IPv4 address in hexadecimal', 'https://0x7f000001'],
    ['an IPv4 address in octal', 'https://0177.0.0.1'],
    ['an IPv4 address cut short', 'https://127.1'],
    ['an IPv4 address with the dot of the root', 'https://127.0.0.1.'],
    ['0.0.0.0', 'https://0.0.0.0'],
    // IPv6.
    ['the IPv6 loopback address', 'https://[::1]'],
    ['an IPv6 address', 'https://[2001:db8::1]:8443/sklep'],
    ['an IPv4 address inside an IPv6 one', 'https://[::ffff:127.0.0.1]'],
    ['a private IPv6 address', 'https://[fd00::1]'],
    // localhost.
    ['localhost', 'https://localhost'],
    ['localhost with a port', 'https://localhost:8443/sklep'],
    ['localhost in capitals', 'https://LOCALHOST'],
    ['localhost with the dot of the root', 'https://localhost.'],
    ['localhost with two dots', 'https://localhost..'],
    ['localhost in full-width letters', 'https://ｌｏｃａｌｈｏｓｔ'],
    ['localhost written with percent signs', 'https://%6c%6fcalhost'],
    ['a name under localhost', 'https://shop.localhost'],
    ['a name under localhost with the dot of the root', 'https://shop.localhost.'],
    // Names without a dot.
    ['a name without a dot', 'https://wordpress'],
    ['a name without a dot, with a port', 'https://intranet:8443'],
    ['a name without a dot, with the dot of the root', 'https://wordpress.'],
    ['a top-level domain alone', 'https://com'],
    // The suffixes kept for private networks.
    ['a name under .local', 'https://shop.local'],
    ['a name under .local, deeper', 'https://sklep.nas.local/woo'],
    ['a name under .local in capitals', 'https://Shop.LOCAL'],
    ['a name under .local with the dot of the root', 'https://shop.local.'],
    ['a name under .local with an ideographic full stop', 'https://shop。local'],
    ['a name under .internal', 'https://shop.internal'],
    ['a cloud\'s internal name', 'https://metadata.google.internal'],
    ['a name under .home.arpa', 'https://shop.home.arpa'],
    ['home.arpa itself', 'https://home.arpa'],
    // Not names at all.
    ['an empty label', 'https://shop..example.test'],
    ['a name that ends in a number', 'https://shop.example.1'],
  ])('refuses %s', (_, storeUrl) => {
    expect(configSchema.safeParse({ storeUrl }).success).toBe(false)
  })

  it('does not repeat the address in its error, which may hold a password', () => {
    const result = configSchema.safeParse({ storeUrl: 'https://admin:hunter22@shop.example.test' })
    expect(JSON.stringify(result.error?.issues)).not.toContain('hunter22')
  })
})

describe('credentialsSchema', () => {
  it('needs both parts of the key', () => {
    expect(credentialsSchema.parse({ consumerKey: ' ck_test_key ', consumerSecret: 'cs_test_secret' })).toEqual({ consumerKey: 'ck_test_key', consumerSecret: 'cs_test_secret' })
    expect(credentialsSchema.safeParse({ consumerKey: 'ck_test_key' }).success).toBe(false)
    expect(credentialsSchema.safeParse({ consumerKey: '', consumerSecret: 'cs_test_secret' }).success).toBe(false)
  })

  it('takes a key as long as WooCommerce makes them, and refuses what is far longer than a key', () => {
    // `ck_` or `cs_` and 40 hexadecimal digits.
    const key = { consumerKey: `ck_${'a1'.repeat(20)}`, consumerSecret: `cs_${'b2'.repeat(20)}` }
    expect(credentialsSchema.parse(key)).toEqual(key)
    expect(credentialsSchema.safeParse({ consumerKey: 'k'.repeat(255), consumerSecret: 's'.repeat(255) }).success).toBe(true)
    expect(credentialsSchema.safeParse({ ...key, consumerKey: 'k'.repeat(256) }).success).toBe(false)
    expect(credentialsSchema.safeParse({ ...key, consumerSecret: 's'.repeat(256) }).success).toBe(false)
  })

  it('does not repeat a key in its error', () => {
    const result = credentialsSchema.safeParse({ consumerKey: `ck_${'secret'.repeat(60)}`, consumerSecret: 'cs_test_secret' })
    expect(JSON.stringify(result.error?.issues)).not.toContain('secret')
  })
})

describe('the connection form', () => {
  it.each([
    ['configSchema', configSchema, { storeUrl: 'Shop address (https://…)' }],
    ['credentialsSchema', credentialsSchema, { consumerKey: 'Consumer key', consumerSecret: 'Consumer secret' }],
  ])('%s is flat labelled text fields the panel can draw', (_, schema, labels) => {
    const json = z.toJSONSchema(schema) as { type: string; properties: Record<string, { type: string; description: string; enum?: unknown }> }
    expect(json.type).toBe('object')
    expect(Object.fromEntries(Object.entries(json.properties).map(([name, field]) => [name, field.description]))).toEqual(labels)
    for (const field of Object.values(json.properties)) expect(field).toMatchObject({ type: 'string' })
  })
})
