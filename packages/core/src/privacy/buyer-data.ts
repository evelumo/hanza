import { addressSchema, buyerSchema } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { SecretBox } from '../secrets'

/** Everything personal an Order holds about its Buyer; sealed as one value (ADR 0011). */
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

/** Erasure requests match an email exactly, ignoring case and surrounding spaces. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function buyerEmailIndex(secrets: SecretBox, email: string): string {
  return secrets.digest(normalizeEmail(email), EMAIL_INDEX_PURPOSE)
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
    buyerEmailIndex: parsed.buyer.email === null ? null : buyerEmailIndex(secrets, parsed.buyer.email),
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

/** Null once the Buyer data was erased. */
export function readBuyerData(secrets: SecretBox, row: StoredBuyerData): BuyerData | null {
  if (row.buyerData !== null) return openBuyerData(secrets, row, row.buyerData)
  if (row.buyerName === null || row.shippingAddress === null) return null
  return buyerDataSchema.parse({
    buyer: { name: row.buyerName, email: row.buyerEmail, phone: row.buyerPhone, login: row.buyerLogin },
    shippingAddress: row.shippingAddress,
    billingAddress: row.billingAddress,
  })
}
