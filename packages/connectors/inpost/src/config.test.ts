import { describe, expect, it } from 'vitest'
import { API_TOKEN_MAX_LENGTH, inpostConfigSchema, inpostCredentialsSchema } from './config'

describe('InPost settings', () => {
  it('names the organization shipxOrganizationId, digits only, never organizationId (Hanza tenant)', () => {
    expect(inpostConfigSchema.parse({ environment: 'sandbox', shipxOrganizationId: ' 12345 ' })).toMatchObject({ shipxOrganizationId: '12345' })
    expect(inpostConfigSchema.safeParse({ environment: 'sandbox', shipxOrganizationId: '12a45' }).success).toBe(false)
    expect(inpostConfigSchema.safeParse({ environment: 'sandbox', organizationId: '12345' }).success).toBe(false)
  })

  it('trims the API token', () => {
    expect(inpostCredentialsSchema.parse({ apiToken: '  eyJhbGciOi.token-value_1  ' })).toEqual({ apiToken: 'eyJhbGciOi.token-value_1' })
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['a space inside', 'abc def'],
    ['a character beyond Latin-1', 'token–value'],
    ['a Latin-1 letter', 'tokén'],
    ['a line break', 'abc\ndef'],
    ['longer than the bound', 'a'.repeat(API_TOKEN_MAX_LENGTH + 1)],
  ])('refuses an API token that is %s', (_what, apiToken) => {
    expect(inpostCredentialsSchema.safeParse({ apiToken }).success).toBe(false)
  })

  it('takes a token at the bound, and every token it takes can go into a header', () => {
    const apiToken = 'a'.repeat(API_TOKEN_MAX_LENGTH)
    expect(inpostCredentialsSchema.parse({ apiToken }).apiToken).toBe(apiToken)
    expect(() => new Headers({ authorization: `Bearer ${apiToken}` })).not.toThrow()
  })
})
