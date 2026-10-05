'use server'

import { createProductsFromOffers, findProductBySku, linkOffer } from '@hanza/core'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, translateIssue, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { revalidateCatalogAndOrders } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { createProductsFromOffersSchema, linkOfferSchema } from '../schemas'
import type { CreateProductsState } from './state'

export async function createProductsFromOffersAction(_previous: CreateProductsState, formData: FormData): Promise<CreateProductsState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = createProductsFromOffersSchema.safeParse({ offerIds: formData.getAll('offerIds').filter((id) => typeof id === 'string') })
  if (!parsed.success) return { error: translateIssue(parsed.error.issues[0]?.message ?? '', t) }

  try {
    const result = await createProductsFromOffers(getContext(), organizationId, [...new Set(parsed.data.offerIds)], { type: 'user', userId: user.id })
    revalidateCatalogAndOrders()
    return { ok: true, created: result.created.length, skipped: result.skipped }
  } catch (error) {
    return failure(error, t)
  }
}

export async function linkOfferAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = linkOfferSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  const ctx = getContext()
  try {
    const product = await findProductBySku(ctx, organizationId, parsed.data.sku)
    if (!product) return { error: t('errors.unknownSku'), values }
    await linkOffer(ctx, organizationId, parsed.data.offerId, product.id, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateCatalogAndOrders()
  return { ok: true }
}
