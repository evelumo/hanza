import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** Seals small secrets (Connection credentials) with AES-256-GCM. */
export interface SecretBox {
  seal(plaintext: string, aad: string): string
  open(sealed: string, aad: string): string
}

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('Encryption key must be base64 of exactly 32 bytes')

  return {
    seal(plaintext, aad) {
      const iv = randomBytes(12)
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
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'), { authTagLength: 16 })
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
