import type { Money, ShippingService } from '@hanza/connector-sdk'
import type { ShipmentInput } from '@hanza/core'
import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import type { MessageKey } from '@/i18n/types'
import { centimetresToMillimetres, kilogramsToGrams } from '@/lib/parcel-input'
import { parsePriceInput } from '@/lib/price-input'

const PRESET_REQUIRED = messageKey('validation.presetRequired')
const DIMENSION_INVALID = messageKey('validation.dimensionInvalid')
const WEIGHT_INVALID = messageKey('validation.weightInvalid')
const PICKUP_POINT_REQUIRED = messageKey('validation.pickupPointRequired')
const COD_INVALID = messageKey('validation.codAmountInvalid')

// What the core takes for a pickup point (`shipmentInputSchema`).
const MAX_POINT_ID_LENGTH = 100

const measure = (read: (raw: string) => number | null, message: MessageKey) =>
  z
    .string({ error: message })
    .refine((raw) => read(raw) !== null, message)
    .transform((raw) => read(raw)!)

/** An empty field collects nothing; anything else must be an amount of the Order's currency. */
function codAmount(raw: string | undefined, currency: string): { money: Money | null } | { error: MessageKey } {
  const value = (raw ?? '').trim()
  if (value === '') return { money: null }
  const parsed = parsePriceInput(value, currency)
  if ('error' in parsed) return { error: parsed.error === 'validation.priceInvalid' ? COD_INVALID : parsed.error }
  return { money: { amount: parsed.amount, currency } }
}

export type ShipmentFormInput = Pick<ShipmentInput, 'parcel' | 'destination' | 'cashOnDelivery'>

/**
 * Reads the fields of the "Create shipment" form for one service. Which fields there are is the service's to say
 * (a preset or dimensions, a pickup point or none), so the schema is built from its declaration on the server and the
 * browser never decides. Dimensions are typed in centimetres and the weight in kilograms; the core takes
 * millimetres and grams.
 *
 * `codCurrency` is the Order's currency when the Carrier may collect money for it (a cash-on-delivery Order and a
 * service that offers it), else null: the amount field is then not read at all, whatever was sent.
 */
export function shipmentFormSchema(service: ShippingService, codCurrency: string | null) {
  const collects = service.cashOnDelivery && codCurrency !== null
  const presets = service.parcel.type === 'presets' ? service.parcel.presets.map((preset) => preset.id) : []
  return z
    .object({
      ...(service.parcel.type === 'presets'
        ? { preset: z.string({ error: PRESET_REQUIRED }).refine((id) => presets.includes(id), PRESET_REQUIRED) }
        : {
            lengthCm: measure(centimetresToMillimetres, DIMENSION_INVALID),
            widthCm: measure(centimetresToMillimetres, DIMENSION_INVALID),
            heightCm: measure(centimetresToMillimetres, DIMENSION_INVALID),
            weightKg: measure(kilogramsToGrams, WEIGHT_INVALID),
          }),
      ...(service.destination === 'pickup_point'
        ? {
            pickupPoint: z
              .string({ error: PICKUP_POINT_REQUIRED })
              .trim()
              .min(1, PICKUP_POINT_REQUIRED)
              .max(MAX_POINT_ID_LENGTH, messageKey('validation.pickupPointTooLong')),
          }
        : {}),
      ...(collects
        ? {
            cashOnDelivery: z
              .string({ error: COD_INVALID })
              .optional()
              .superRefine((raw, ctx) => {
                const amount = codAmount(raw, codCurrency)
                if ('error' in amount) ctx.addIssue({ code: 'custom', message: amount.error })
              }),
          }
        : {}),
    })
    .transform((fields): ShipmentFormInput => {
      const read = fields as Partial<Record<'lengthCm' | 'widthCm' | 'heightCm' | 'weightKg', number>> & Partial<Record<'preset' | 'pickupPoint' | 'cashOnDelivery', string>>
      const amount = collects ? codAmount(read.cashOnDelivery, codCurrency) : { money: null }
      return {
        parcel:
          service.parcel.type === 'presets'
            ? { preset: read.preset! }
            : { lengthMm: read.lengthCm!, widthMm: read.widthCm!, heightMm: read.heightCm!, weightGrams: read.weightKg! },
        destination: service.destination === 'pickup_point' ? { type: 'pickup_point', pointId: read.pickupPoint! } : { type: 'address' },
        cashOnDelivery: 'money' in amount ? amount.money : null,
      }
    })
}
