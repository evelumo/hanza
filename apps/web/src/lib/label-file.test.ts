import { describe, expect, it } from 'vitest'
import { labelFileName } from './label-file'

describe('labelFileName', () => {
  it('is named after the tracking number, or the Shipment id without one', () => {
    expect(labelFileName({ id: 'shp_1', trackingNumber: 'FAKE000001' }, 'pdf')).toBe('label-FAKE000001.pdf')
    expect(labelFileName({ id: 'shp_1', trackingNumber: null }, 'png')).toBe('label-shp_1.png')
  })

  it('keeps nothing of a tracking number that could break the header or name a path', () => {
    expect(labelFileName({ id: 'shp_1', trackingNumber: '62"; filename="x.exe\r\nSet-Cookie: a=b' }, 'pdf')).toBe('label-62filenamex.exeSet-Cookieab.pdf')
    expect(labelFileName({ id: 'shp_1', trackingNumber: '../../etc/passwd' }, 'pdf')).toBe('label-etcpasswd.pdf')
    expect(labelFileName({ id: 'shp_1', trackingNumber: 'żółć / ' }, 'pdf')).toBe('label-shp_1.pdf')
    expect(labelFileName({ id: 'shp_1', trackingNumber: 'A'.repeat(200) }, 'pdf')).toBe(`label-${'A'.repeat(80)}.pdf`)
  })
})
