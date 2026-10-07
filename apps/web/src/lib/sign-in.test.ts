import { describe, expect, it } from 'vitest'
import { formatUserCode, isSignInOpen, signInLink } from './sign-in'

describe('formatUserCode', () => {
  it('groups a nine-character code in threes', () => {
    expect(formatUserCode('ABCDEFGHI')).toBe('ABC DEF GHI')
    expect(formatUserCode('ABC DEF GHI')).toBe('ABC DEF GHI')
  })

  it('leaves other codes as they are', () => {
    expect(formatUserCode('WDJB-MJHT')).toBe('WDJB-MJHT')
  })
})

describe('signInLink', () => {
  const hosts = ['login.example.test']

  it('prefers the page with the code filled in', () => {
    expect(
      signInLink({ verificationUri: 'https://login.example.test/d', verificationUriComplete: 'https://login.example.test/d?code=X' }, hosts),
    ).toBe('https://login.example.test/d?code=X')
  })

  it('falls back to the plain page, and shows nothing outside the declared hosts', () => {
    expect(signInLink({ verificationUri: 'https://login.example.test/d', verificationUriComplete: 'https://evil.example/d' }, hosts)).toBe(
      'https://login.example.test/d',
    )
    expect(signInLink({ verificationUri: 'javascript:alert(1)', verificationUriComplete: null }, hosts)).toBeNull()
    expect(signInLink({ verificationUri: 'http://login.example.test/d', verificationUriComplete: null }, hosts)).toBeNull()
  })
})

describe('isSignInOpen', () => {
  it('is true only while starting or pending', () => {
    expect(['starting', 'pending', 'approved', 'denied', 'expired'].map(isSignInOpen)).toEqual([true, true, false, false, false])
  })
})
