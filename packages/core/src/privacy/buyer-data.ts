import { addressSchema, buyerSchema } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { SecretBox } from '../secrets'

/** Everything personal an Order holds about its Buyer; sealed as one value (ADR 0016). */
export const buyerDataSchema = z.object({
  buyer: buyerSchema,
  shippingAddress: addressSchema,
  billingAddress: addressSchema.nullable(),
})

export type BuyerData = z.infer<typeof buyerDataSchema>

/** What a sealed value is bound to: a value copied to another Order or tenant does not open. */
export interface OrderKey {
  organizationId: string
  connectionId: string
  externalId: string
}

const EMAIL_INDEX_PURPOSE = 'buyer-email'

function aad(key: OrderKey): string {
  return JSON.stringify(['buyer-data', key.organizationId, key.connectionId, key.externalId])
}

/**
 * Every character JS `String.prototype.trim()` strips (WhiteSpace and LineTerminator), as the body of a
 * regex bracket expression, so SQL can trim legacy plaintext the same way `normalizeEmail` does.
 */
export const JS_TRIM_WHITESPACE = '\t\n\v\f\r    -     　﻿'

/** Erasure requests match an email exactly, ignoring Unicode composition, case and surrounding spaces. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase()
}

/** The organization is part of the input, so one Buyer cannot be linked across organizations by reading the database. */
export function buyerEmailIndex(secrets: SecretBox, organizationId: string, email: string): string {
  return secrets.digest(JSON.stringify([organizationId, normalizeEmail(email)]), EMAIL_INDEX_PURPOSE)
}

/** The Order columns that store `data`: the sealed snapshot, the email index and the country kept after erasure. */
export function sealBuyerData(
  secrets: SecretBox,
  key: OrderKey,
  data: BuyerData,
): { buyerData: string; buyerEmailIndex: string | null; shippingCountryCode: string } {
  const parsed = buyerDataSchema.parse(data)
  return {
    buyerData: secrets.seal(JSON.stringify(parsed), aad(key)),
    buyerEmailIndex: parsed.buyer.email === null ? null : buyerEmailIndex(secrets, key.organizationId, parsed.buyer.email),
    shippingCountryCode: parsed.shippingAddress.countryCode,
  }
}

export function openBuyerData(secrets: SecretBox, key: OrderKey, sealed: string): BuyerData {
  return buyerDataSchema.parse(JSON.parse(secrets.open(sealed, aad(key))))
}

/** The Buyer columns of an Order row, in either shape: sealed, or legacy plaintext not swept yet. */
export interface StoredBuyerData extends OrderKey {
  buyerData: string | null
  buyerName: string | null
  buyerEmail: string | null
  buyerPhone: string | null
  buyerLogin: string | null
  shippingAddress: unknown
  billingAddress: unknown
}

export const storedBuyerDataSelect = {
  organizationId: true,
  connectionId: true,
  externalId: true,
  buyerData: true,
  buyerName: true,
  buyerEmail: true,
  buyerPhone: true,
  buyerLogin: true,
  shippingAddress: true,
  billingAddress: true,
} as const

/**
 * Throws when the stored value does not open or does not parse, including a legacy row with only part of
 * the snapshot (a name without an address); null once the Buyer data was erased.
 */
export function readBuyerData(secrets: SecretBox, row: StoredBuyerData): BuyerData | null {
  if (row.buyerData !== null) return openBuyerData(secrets, row, row.buyerData)
  if (row.buyerName === null && row.shippingAddress === null) return null
  return buyerDataSchema.parse({
    buyer: { name: row.buyerName, email: row.buyerEmail, phone: row.buyerPhone, login: row.buyerLogin },
    shippingAddress: row.shippingAddress,
    billingAddress: row.billingAddress,
  })
}

/** What the panel can show of an Order's Buyer data. */
export type BuyerDataView = { state: 'present'; data: BuyerData } | { state: 'erased' } | { state: 'unreadable' }

/**
 * Never throws: one value that does not open (wrong key, tampered or truncated) or a legacy row that
 * fails the schema must not take down a whole Order list. The caller logs the Order id.
 */
export function viewBuyerData(secrets: SecretBox, row: StoredBuyerData): BuyerDataView {
  try {
    const data = readBuyerData(secrets, row)
    return data === null ? { state: 'erased' } : { state: 'present', data }
  } catch {
    return { state: 'unreadable' }
  }
}
