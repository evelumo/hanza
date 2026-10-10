import type { CapabilityContext } from '@hanza/connector-sdk'
import { z } from 'zod'

export const INPOST_BASE_URLS = {
  production: 'https://api-shipx-pl.easypack24.net',
  sandbox: 'https://sandbox-api-shipx-pl.easypack24.net',
} as const

export const LOCKER_SERVICE = 'inpost_locker_standard'
export const COURIER_SERVICE = 'inpost_courier_standard'

// Flat fields only: the panel draws the Connection form from these, with the description as the label.
export const inpostConfigSchema = z.object({
  environment: z.enum(['production', 'sandbox']).describe('Environment'),
  organizationId: z
    .string()
    .regex(/^\d+$/)
    .describe('Organization ID (the API tab of the InPost manager)'),
  // `parcel_locker` is left out: it needs a drop-off locker chosen per parcel, which a Connection setting cannot be.
  lockerSendingMethod: z
    .enum(['any_point', 'dispatch_order', 'pop', 'branch'])
    .default('any_point')
    .describe('How locker parcels are handed to InPost'),
  courierSendingMethod: z
    .enum(['dispatch_order', 'pop', 'branch'])
    .default('dispatch_order')
    .describe('How courier parcels are handed to InPost'),
  labelType: z.enum(['A6', 'normal']).default('A6').describe('Label size'),
})
export type InpostConfig = z.output<typeof inpostConfigSchema>

export const inpostCredentialsSchema = z.object({ apiToken: z.string().min(1).describe('API token') })
export type InpostCredentials = z.output<typeof inpostCredentialsSchema>

export type InpostContext = CapabilityContext<InpostConfig, InpostCredentials>
