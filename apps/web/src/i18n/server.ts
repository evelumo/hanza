import { getLocale, getTranslations } from 'next-intl/server'
import type { Locale } from './config'
import type { Translator } from './types'

/** The root translator of the current request, for server components and actions. */
export async function getT(): Promise<Translator> {
  return getTranslations()
}

export async function getActiveLocale(): Promise<Locale> {
  return (await getLocale()) as Locale
}
