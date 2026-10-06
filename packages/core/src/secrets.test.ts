import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSecretBox } from './secrets'

const key = () => randomBytes(32).toString('base64')

describe('createSecretBox', () => {
  it('round-trips and uses the v1:iv:tag:ciphertext format', () => {
    const box = createSecretBox(key())
    const sealed = box.seal('{"apiKey":"s3cret"}', 'org-1')
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(sealed).not.toContain('s3cret')
    expect(box.open(sealed, 'org-1')).toBe('{"apiKey":"s3cret"}')
  })

  it('uses a fresh IV per seal', () => {
    const box = createSecretBox(key())
    expect(box.seal('same', 'org-1')).not.toBe(box.seal('same', 'org-1'))
  })

  it('rejects tampered ciphertext', () => {
    const box = createSecretBox(key())
    const [version, iv, tag, ciphertext] = box.seal('secret value', 'org-1').split(':') as [string, string, string, string]
    const bytes = Buffer.from(ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    expect(() => box.open([version, iv, tag, bytes.toString('base64')].join(':'), 'org-1')).toThrow()
  })

  it('rejects the wrong AAD (another organization)', () => {
    const box = createSecretBox(key())
    expect(() => box.open(box.seal('secret', 'org-1'), 'org-2')).toThrow()
  })

  it('rejects the wrong key', () => {
    const sealed = createSecretBox(key()).seal('secret', 'org-1')
    expect(() => createSecretBox(key()).open(sealed, 'org-1')).toThrow()
  })

  it('rejects an IV or auth tag of the wrong length with the format error', () => {
    const box = createSecretBox(key())
    const [version, iv, tag, ciphertext] = box.seal('secret', 'org-1').split(':') as [string, string, string, string]
    const longIv = Buffer.concat([Buffer.from(iv, 'base64'), Buffer.alloc(4)]).toString('base64')
    const shortTag = Buffer.from(tag, 'base64').subarray(0, 12).toString('base64')
    for (const sealed of [[version, longIv, tag, ciphertext], [version, '', tag, ciphertext], [version, iv, shortTag, ciphertext]]) {
      expect(() => box.open(sealed.join(':'), 'org-1')).toThrow(/^Unsupported sealed value format$/)
    }
  })

  it('rejects an unknown format', () => {
    expect(() => createSecretBox(key()).open('v2:a:b:c', 'org-1')).toThrow(/format/)
  })
})

describe('digest', () => {
  it('is stable for one key and purpose, versioned, and does not contain the value', () => {
    const secret = key()
    const digest = createSecretBox(secret).digest('john@example.com', 'buyer-email')
    expect(digest).toMatch(/^v1:[A-Za-z0-9_-]{43}$/)
    expect(digest).not.toContain('john')
    expect(createSecretBox(secret).digest('john@example.com', 'buyer-email')).toBe(digest)
  })

  it('depends on the key, the purpose and the value', () => {
    const secret = key()
    const box = createSecretBox(secret)
    const digest = box.digest('john@example.com', 'buyer-email')
    expect(createSecretBox(key()).digest('john@example.com', 'buyer-email')).not.toBe(digest)
    expect(box.digest('john@example.com', 'other')).not.toBe(digest)
    expect(box.digest('jane@example.com', 'buyer-email')).not.toBe(digest)
  })
})
