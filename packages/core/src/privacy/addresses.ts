import type { Address, Delivery } from '@hanza/connector-sdk'
import { Prisma, type Tx } from '@hanza/db'
import type { SecretBox } from '../secrets'
import { buyerDataSchema, readBuyerData, sealBuyerData, storedBuyerDataSelect } from './buyer-data'

/** Absent = keep the stored one; `billingAddress: null` = the Order has no billing address. */
export interface AddressChange {
  shippingAddress?: Address
  billingAddress?: Address | null
  delivery?: Delivery
}

export type AddressReplacement =
  /** Which parts changed; `pickupPoint` says whether a changed Delivery names another pickup point. */
  | { result: 'replaced'; shippingAddress: boolean; billingAddress: boolean; delivery: boolean; pickupPoint: boolean }
  /** The addresses and the Delivery already were these: nothing written. */
  | { result: 'unchanged' }
  /** The Buyer data was erased: it never comes back (ADR 0016). */
  | { result: 'erased' }
  /** The stored value does not open or does not parse: left as it is. */
  | { result: 'unreadable' }

/**
 * Replaces an Order's addresses and Delivery inside its sealed Buyer data (ADR 0016): reads the stored snapshot, puts
 * the new ones in, and seals it again, clearing the legacy plaintext columns as the sweep does. The Buyer is
 * unchanged, so the email index stays. Caller holds the Order lock and decides whether the Order may change them.
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

  const delivery = change.delivery ?? current.delivery
  const next = buyerDataSchema.parse({
    buyer: current.buyer,
    shippingAddress: change.shippingAddress ?? current.shippingAddress,
    billingAddress: change.billingAddress === undefined ? current.billingAddress : change.billingAddress,
    // Left out, not undefined, when there is none: the stored value keeps the shape it had.
    ...(delivery === undefined ? {} : { delivery }),
  })
  // Both went through the same schema, so equal values serialize to equal strings.
  const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  const shippingAddress = differs(next.shippingAddress, current.shippingAddress)
  const billingAddress = differs(next.billingAddress, current.billingAddress)
  const deliveryChanged = differs(next.delivery, current.delivery)
  if (!shippingAddress && !billingAddress && !deliveryChanged) return { result: 'unchanged' }

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
  return {
    result: 'replaced',
    shippingAddress,
    billingAddress,
    delivery: deliveryChanged,
    pickupPoint: differs(next.delivery?.pickupPoint, current.delivery?.pickupPoint),
  }
}
