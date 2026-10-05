import { describe, expect, it } from 'vitest'
import { safeHttpUrl } from './safe-url'

describe('safeHttpUrl', () => {
  it('keeps http and https links', () => {
    expect(safeHttpUrl('https://allegro.pl/oferta/1')).toBe('https://allegro.pl/oferta/1')
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com',
    'mailto:a@b.pl',
    '//example.com/relative',
    '/relative/path',
    'not a url',
    '',
  ])('refuses %j', (value) => {
    expect(safeHttpUrl(value)).toBeNull()
  })

  it('refuses a missing value', () => {
    expect(safeHttpUrl(null)).toBeNull()
    expect(safeHttpUrl(undefined)).toBeNull()
  })
})
