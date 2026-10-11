import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSecretBox } from '../secrets'
import { labelFileType, openDestination, openLabel, sealDestination, sealLabel, storedContentType } from './sealed'

const box = () => createSecretBox(randomBytes(32).toString('base64'))
const key = { organizationId: 'org-1', shipmentId: 'shipment-1' }

describe('sealed Shipment values', () => {
  it('seals the confirmed destination and binds it to its Shipment and tenant', () => {
    const secrets = box()
    const sealed = sealDestination(secrets, key, { type: 'pickup_point', pointId: 'KRA010' })
    expect(sealed).not.toContain('KRA010')
    expect(openDestination(secrets, key, sealed)).toEqual({ type: 'pickup_point', pointId: 'KRA010' })
    expect(() => openDestination(secrets, { ...key, shipmentId: 'shipment-2' }, sealed)).toThrow()
    expect(() => openDestination(secrets, { ...key, organizationId: 'org-2' }, sealed)).toThrow()
    expect(openDestination(secrets, key, sealDestination(secrets, key, { type: 'address' }))).toEqual({ type: 'address' })
  })

  it('seals a Label byte for byte, bound the same way, and not openable as a destination', () => {
    const secrets = box()
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a])
    const sealed = sealLabel(secrets, key, data)
    expect(sealed).not.toContain(Buffer.from(data).toString('base64'))
    expect(openLabel(secrets, key, sealed)).toEqual(data)
    expect(() => openLabel(secrets, { ...key, shipmentId: 'shipment-2' }, sealed)).toThrow()
    expect(() => openLabel(secrets, { ...key, organizationId: 'org-2' }, sealed)).toThrow()
    expect(() => openDestination(secrets, key, sealed)).toThrow()
  })
})

describe('Label content types', () => {
  it('stores the bare media type, and nothing that is not one', () => {
    expect(storedContentType('application/pdf')).toBe('application/pdf')
    expect(storedContentType('Application/PDF; charset=binary')).toBe('application/pdf')
    expect(storedContentType('text/zpl')).toBe('text/zpl')
    expect(storedContentType('Jan Kowalski, ul. Długa 1')).toBe('application/octet-stream')
    expect(storedContentType('')).toBe('application/octet-stream')
    expect(storedContentType('text/html\r\nSet-Cookie: x=1')).toBe('application/octet-stream')
  })

  it('serves only a PDF, a PNG or printer commands as what they are; anything else is a download', () => {
    expect(labelFileType('application/pdf')).toEqual({ contentType: 'application/pdf', extension: 'pdf' })
    expect(labelFileType('image/png')).toEqual({ contentType: 'image/png', extension: 'png' })
    for (const type of ['text/zpl', 'application/zpl', 'application/x-zpl', 'x-application/zpl']) {
      expect(labelFileType(type)).toEqual({ contentType: 'text/plain; charset=utf-8', extension: 'zpl' })
    }
    expect(labelFileType('application/epl')).toEqual({ contentType: 'text/plain; charset=utf-8', extension: 'epl' })
    for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'application/octet-stream', 'text/plain']) {
      expect(labelFileType(type)).toEqual({ contentType: 'application/octet-stream', extension: 'bin' })
    }
  })
})
