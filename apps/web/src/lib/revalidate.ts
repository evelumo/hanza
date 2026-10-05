import { revalidatePath } from 'next/cache'

/** Stock, Reservations and Offers show up on both lists, so a change refreshes both. */
export function revalidateCatalogAndOrders(): void {
  revalidatePath('/products', 'layout')
  revalidatePath('/orders', 'layout')
}
