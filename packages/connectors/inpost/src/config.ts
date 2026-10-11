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
  // Not `organizationId`: that is Hanza's tenant, and a config field cannot be renamed once Connections store it.
  shipxOrganizationId: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .describe('ShipX organization ID (the API tab of the InPost manager)'),
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

// Printable ASCII without spaces, as a token is: it goes into the Authorization header, and `Headers` throws on a
// character beyond Latin-1, which would fail every request of the Connection, retried for ever. The bound keeps what
// is pasted by mistake out of the header too.
const API_TOKEN = /^[\x21-\x7E]+$/
export const API_TOKEN_MAX_LENGTH = 512

export const inpostCredentialsSchema = z.object({
  apiToken: z.string().trim().min(1).max(API_TOKEN_MAX_LENGTH).regex(API_TOKEN).describe('API token'),
})
export type InpostCredentials = z.output<typeof inpostCredentialsSchema>

export type InpostContext = CapabilityContext<InpostConfig, InpostCredentials>
