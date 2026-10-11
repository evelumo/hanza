import { revalidatePath } from 'next/cache'

/** Stock, Reservations and Offers show up on both lists, so a change refreshes both. */
export function revalidateCatalogAndOrders(): void {
  revalidatePath('/products', 'layout')
  revalidatePath('/orders', 'layout')
}

/** A Shipment shows on its Order's page only; it moves no Stock until its Carrier takes the parcel, which the worker sees. */
export function revalidateOrders(): void {
  revalidatePath('/orders', 'layout')
}

/** A family shows on its own pages and, per Product, on the Products pages. */
export function revalidateFamilies(): void {
  revalidatePath('/families', 'layout')
  revalidatePath('/products', 'layout')
}
