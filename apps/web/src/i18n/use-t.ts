import { useTranslations } from 'next-intl'
import type { Translator } from './types'

/** The root translator for components that are not async (client components and plain server ones). */
export function useT(): Translator {
  return useTranslations()
}
