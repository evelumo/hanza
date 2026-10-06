import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bodyHash, canonicalJson, encodeBody, loadCassette } from './cassette'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('encodeBody', () => {
  it('keeps JSON parsed, text as text and binary as base64', () => {
    expect(encodeBody(bytes(''), 'application/json')).toBeNull()
    expect(encodeBody(bytes('{"a":1}'), 'application/vnd.api+json; charset=utf-8')).toEqual({ json: { a: 1 } })
    expect(encodeBody(bytes('{"a":1}'), null)).toEqual({ json: { a: 1 } })
    expect(encodeBody(bytes('{broken'), 'application/json')).toEqual({ text: '{broken' })
    expect(encodeBody(bytes('a=1&b=2'), 'application/x-www-form-urlencoded')).toEqual({ text: 'a=1&b=2' })
    expect(encodeBody(new Uint8Array([0x25, 0x50, 0xff]), 'application/pdf')).toEqual({ base64: 'JVD/' })
    expect(encodeBody(new Uint8Array([0xff, 0xfe]), null)).toEqual({ base64: '//4=' })
  })
})

describe('bodyHash', () => {
  it('ignores JSON key order and form parameter order, nothing else', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}')
    expect(bodyHash({ json: { a: 1, b: 2 } }, null)).toBe(bodyHash({ json: { b: 2, a: 1 } }, null))
    expect(bodyHash({ text: 'a=1&b=2' }, 'application/x-www-form-urlencoded')).toBe(bodyHash({ text: 'b=2&a=1' }, 'application/x-www-form-urlencoded'))
    expect(bodyHash({ text: 'a=1&b=2' }, 'text/plain')).not.toBe(bodyHash({ text: 'b=2&a=1' }, 'text/plain'))
    expect(bodyHash(null, null)).toBeNull()
  })
})

describe('loadCassette', () => {
  it('rejects a file that is not a cassette, with the reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hanza-cassette-'))
    try {
      const file = join(dir, 'bad.cassette.json')
      await writeFile(file, JSON.stringify({ version: 1, interactions: [{ request: { method: 'GET', url: 'not a url', headers: {}, body: null } }] }))
      await expect(loadCassette(file)).rejects.toThrow(/bad\.cassette\.json is not a valid cassette/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
