import { z } from 'zod'

/** `POST {oauth}/token`: a refresh, or an approved device code. */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().nullish(),
  jti: z.string().nullish(),
  token_type: z.string().nullish(),
})
export type TokenResponse = z.output<typeof tokenResponseSchema>

/** `POST {oauth}/device`. */
export const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().nullish(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
})
export type DeviceAuthorization = z.output<typeof deviceAuthorizationSchema>

/** `GET /me`: only the account id and login, which identify the Connection's account; names and e-mail stay out. */
export const meSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1),
})
export type Me = z.output<typeof meSchema>
