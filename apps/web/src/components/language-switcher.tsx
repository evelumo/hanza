import { tabActiveClass, tabClass } from '@/components/ui/tab-styles'
import { setLocaleAction } from '@/i18n/actions'
import { localeNames, locales } from '@/i18n/config'
import { getActiveLocale, getT } from '@/i18n/server'
import { cn } from '@/lib/utils'

/** A form of plain submit buttons: it works without client JavaScript, and Next refreshes the page once the cookie is set. */
export async function LanguageSwitcher() {
  const [active, t] = await Promise.all([getActiveLocale(), getT()])
  return (
    <form action={setLocaleAction}>
      <div role="group" aria-label={t('language.label')} className="flex items-center gap-1">
        {locales.map((locale) => (
          <button
            key={locale}
            type="submit"
            name="locale"
            value={locale}
            lang={locale}
            aria-pressed={locale === active}
            className={cn(tabClass, locale === active && tabActiveClass)}
          >
            {localeNames[locale]}
          </button>
        ))}
      </div>
    </form>
  )
}
