export const locales = ['en', 'pl'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'en'

export const LOCALE_COOKIE = 'hanza_locale'

export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Each language is written in itself, so a user who cannot read the current one can still find theirs. */
export const localeNames: Record<Locale, string> = { en: 'English', pl: 'Polski' }

/**
 * Locale used for number and date formatting. The bare `en` would format as en-US (month first, 12-hour
 * clock), which is wrong for a panel whose users run shops in Europe; en-GB is unambiguous.
 */
export const formatLocales: Record<Locale, string> = { en: 'en-GB', pl: 'pl-PL' }

// The panel's users are in Poland and the server's own zone is UTC in a container.
export const PANEL_TIME_ZONE = 'Europe/Warsaw'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value)
}
