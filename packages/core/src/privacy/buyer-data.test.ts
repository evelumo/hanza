import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSecretBox } from '../secrets'
import { buyerEmailIndex, normalizeEmail, openBuyerData, readBuyerData, sealBuyerData, type BuyerData } from './buyer-data'
import { retentionCutoff } from './sweep'

const box = () => createSecretBox(randomBytes(32).toString('base64'))
const key = { organizationId: 'org-1', connectionId: 'conn-1', externalId: 'order-1' }
const data: BuyerData = {
  buyer: { name: 'Jan Kowalski', email: 'Jan.Kowalski@Example.com', phone: '+48 600 100 200', login: 'jank' },
  shippingAddress: {
    name: 'Jan Kowalski',
    company: null,
    street: 'ul. Długa 1/2',
    postalCode: '00-001',
    city: 'Warszawa',
    countryCode: 'PL',
    phone: null,
    taxId: null,
  },
  billingAddress: null,
}

describe('sealBuyerData', () => {
  it('seals everything personal into one value and keeps only the country in plaintext', () => {
    const secrets = box()
    const columns = sealBuyerData(secrets, key, data)
    expect(columns.shippingCountryCode).toBe('PL')
    expect(columns.buyerData).toMatch(/^v1:/)
    for (const personal of ['Jan', 'Kowalski', 'example.com', '600', 'Długa', 'Warszawa', 'jank']) {
      expect(columns.buyerData).not.toContain(personal)
      expect(columns.buyerEmailIndex).not.toContain(personal)
    }
    expect(openBuyerData(secrets, key, columns.buyerData)).toEqual(data)
  })

  it('binds the value to its Order and tenant', () => {
    const secrets = box()
    const { buyerData } = sealBuyerData(secrets, key, data)
    expect(() => openBuyerData(secrets, { ...key, organizationId: 'org-2' }, buyerData)).toThrow()
    expect(() => openBuyerData(secrets, { ...key, externalId: 'order-2' }, buyerData)).toThrow()
    expect(() => openBuyerData(secrets, { ...key, connectionId: 'conn-2' }, buyerData)).toThrow()
  })

  it('indexes the email ignoring case and spaces, and has no index without an email', () => {
    const secrets = box()
    expect(sealBuyerData(secrets, key, data).buyerEmailIndex).toBe(buyerEmailIndex(secrets, '  jan.kowalski@example.COM '))
    expect(sealBuyerData(secrets, key, { ...data, buyer: { ...data.buyer, email: null } }).buyerEmailIndex).toBeNull()
  })

  it('refuses data that breaks the canonical schema', () => {
    expect(() => sealBuyerData(box(), key, { ...data, buyer: { ...data.buyer, name: '' } })).toThrow()
  })
})

describe('readBuyerData', () => {
  const legacy = {
    ...key,
    buyerData: null,
    buyerName: 'Jan Kowalski',
    buyerEmail: 'Jan.Kowalski@Example.com',
    buyerPhone: '+48 600 100 200',
    buyerLogin: 'jank',
    shippingAddress: data.shippingAddress,
    billingAddress: null,
  }

  it('reads the sealed shape and the legacy plaintext shape alike', () => {
    const secrets = box()
    const sealed = { ...legacy, buyerName: null, buyerEmail: null, buyerPhone: null, buyerLogin: null, shippingAddress: null }
    expect(readBuyerData(secrets, { ...sealed, buyerData: sealBuyerData(secrets, key, data).buyerData })).toEqual(data)
    expect(readBuyerData(secrets, legacy)).toEqual(data)
  })

  it('returns null once erased', () => {
    const erased = { ...legacy, buyerName: null, buyerEmail: null, buyerPhone: null, buyerLogin: null, shippingAddress: null }
    expect(readBuyerData(box(), erased)).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John@Example.COM\n')).toBe('john@example.com')
  })
})

describe('retentionCutoff', () => {
  it('goes back the given number of whole days', () => {
    expect(retentionCutoff(new Date('2026-10-05T12:00:00Z'), 30).toISOString()).toBe('2026-09-05T12:00:00.000Z')
  })
})
