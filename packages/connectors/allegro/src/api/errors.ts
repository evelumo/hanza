import { z } from 'zod'

// Only `code` (and the OAuth `error`) is ever read: messages may echo request data back and are never shown or logged.

export const errorSchema = z.object({
  code: z.string(),
  message: z.string().nullish(),
  details: z.string().nullish(),
  path: z.string().nullish(),
  userMessage: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
})

/** Allegro's error body for a status of 400 and above (`ErrorsHolder`). */
export const errorsHolderSchema = z.object({
  errors: z.array(errorSchema),
})

/** The OAuth error body: the token endpoint's 400s, and any 401 (`AuthError`). */
export const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().nullish(),
})
