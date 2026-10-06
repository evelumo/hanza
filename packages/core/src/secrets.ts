import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

/** Seals small secrets (Connection credentials, Buyer data) with AES-256-GCM. */
export interface SecretBox {
  seal(plaintext: string, aad: string): string
  open(sealed: string, aad: string): string
  /**
   * Keyed HMAC-SHA256 of `value` for exact-match lookups (a blind index), as `v1:<base64url>`.
   * Each `purpose` gets its own key derived with HKDF, never the sealing key itself.
   */
  digest(value: string, purpose: string): string
}

// The version names the key and algorithm, so a key rotation can add `v2` beside it.
const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('Encryption key must be base64 of exactly 32 bytes')
  const digestKeys = new Map<string, Buffer>()
  const digestKey = (purpose: string) => {
    let derived = digestKeys.get(purpose)
    if (!derived) {
      derived = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `hanza/digest/${VERSION}/${purpose}`, 32))
      digestKeys.set(purpose, derived)
    }
    return derived
  }

  return {
    digest(value, purpose) {
      return `${VERSION}:${createHmac('sha256', digestKey(purpose)).update(value, 'utf8').digest('base64url')}`
    },
    seal(plaintext, aad) {
      const iv = randomBytes(IV_LENGTH)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
    },
    open(sealed, aad) {
      const [version, iv, tag, ciphertext, ...rest] = sealed.split(':')
      if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined || rest.length > 0) {
        throw new Error('Unsupported sealed value format')
      }
      const ivBytes = Buffer.from(iv, 'base64')
      const tagBytes = Buffer.from(tag, 'base64')
      // GCM accepts other IV lengths, but this format only ever writes 12 bytes.
      if (ivBytes.length !== IV_LENGTH || tagBytes.length !== TAG_LENGTH) throw new Error('Unsupported sealed value format')
      const decipher = createDecipheriv(ALGORITHM, key, ivBytes, { authTagLength: TAG_LENGTH })
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(tagBytes)
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
