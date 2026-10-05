import { getActiveLocale } from '@/i18n/server'
import { createFormatters, type Formatters } from './format'

/** Formatters for the request's locale, for server components. */
export async function getFormatters(): Promise<Formatters> {
  return createFormatters(await getActiveLocale())
}
