import { createTranslator } from 'next-intl'
import { catalogues } from './catalogues'
import type { Locale } from './config'
import type { Translator } from './types'

/** A real translator over the real catalogue, so tests assert what the panel shows. */
export function translatorFor(locale: Locale = 'en'): Translator {
  return createTranslator({ locale, messages: catalogues[locale] })
}
