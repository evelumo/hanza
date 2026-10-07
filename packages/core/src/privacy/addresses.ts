import type { Address } from '@hanza/connector-sdk'
import { Prisma, type Tx } from '@hanza/db'
import type { SecretBox } from '../secrets'
import { buyerDataSchema, readBuyerData, sealBuyerData, storedBuyerDataSelect } from './buyer-data'

/** Absent = keep the stored address; `billingAddress: null` = the Order has no billing address. */
export interface AddressChange {
  shippingAddress?: Address
  billingAddress?: Address | null
}

export type AddressReplacement =
  | { result: 'replaced'; shippingAddress: boolean; billingAddress: boolean }
  /** The addresses already were these: nothing written. */
  | { result: 'unchanged' }
  /** The Buyer data was erased: it never comes back (ADR 0016). */
  | { result: 'erased' }
  /** The stored value does not open or does not parse: left as it is. */
  | { result: 'unreadable' }

/**
 * Replaces an Order's addresses inside its sealed Buyer data (ADR 0016): reads the stored snapshot, puts the new
 * addresses in, and seals it again, clearing the legacy plaintext columns as the sweep does. The Buyer is unchanged,
 * so the email index stays. Caller holds the Order lock and decides whether the Order may change its addresses.
 */
export async function replaceBuyerAddresses(
  tx: Tx,
  secrets: SecretBox,
  organizationId: string,
  orderId: string,
  change: AddressChange,
): Promise<AddressReplacement> {
  const row = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    select: { ...storedBuyerDataSelect, buyerDataErasedAt: true },
  })
  if (!row || row.buyerDataErasedAt !== null) return { result: 'erased' }

  let current
  try {
    current = readBuyerData(secrets, row)
  } catch {
    return { result: 'unreadable' }
  }
  if (current === null) return { result: 'erased' }

  const next = buyerDataSchema.parse({
    buyer: current.buyer,
    shippingAddress: change.shippingAddress ?? current.shippingAddress,
    billingAddress: change.billingAddress === undefined ? current.billingAddress : change.billingAddress,
  })
  // Both went through the same schema, so equal addresses serialize to equal strings.
  const shippingAddress = JSON.stringify(next.shippingAddress) !== JSON.stringify(current.shippingAddress)
  const billingAddress = JSON.stringify(next.billingAddress) !== JSON.stringify(current.billingAddress)
  if (!shippingAddress && !billingAddress) return { result: 'unchanged' }

  await tx.order.updateMany({
    where: { id: orderId, organizationId },
    data: {
      ...sealBuyerData(secrets, row, next),
      buyerName: null,
      buyerEmail: null,
      buyerPhone: null,
      buyerLogin: null,
      shippingAddress: Prisma.DbNull,
      billingAddress: Prisma.DbNull,
    },
  })
  return { result: 'replaced', shippingAddress, billingAddress }
}
