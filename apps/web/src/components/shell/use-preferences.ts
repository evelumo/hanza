'use client'

import { useLocale } from 'next-intl'
import { useTheme } from 'next-themes'
import { useTransition } from 'react'
import { setLocaleAction } from '@/i18n/actions'
import type { Locale } from '@/i18n/config'

export const themes = ['light', 'dark', 'system'] as const

export type ThemeChoice = (typeof themes)[number]

/** Language and theme, as the user menu and the command palette both change them. */
export function usePreferences() {
  const locale = useLocale() as Locale
  const { theme, setTheme } = useTheme()
  const [, startTransition] = useTransition()

  function setLocale(next: string) {
    const data = new FormData()
    data.set('locale', next)
    // The action sets the cookie and revalidates the layout, so the page comes back in the new language.
    startTransition(() => setLocaleAction(data))
  }

  return { locale, setLocale, theme: (theme ?? 'system') as ThemeChoice, setTheme }
}
