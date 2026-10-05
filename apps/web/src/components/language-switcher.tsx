import { setLocaleAction } from '@/i18n/actions'
import { localeNames, locales } from '@/i18n/config'
import { getActiveLocale, getT } from '@/i18n/server'

/** A form of plain submit buttons: it works without client JavaScript, and Next refreshes the page once the cookie is set. */
export async function LanguageSwitcher() {
  const [active, t] = await Promise.all([getActiveLocale(), getT()])
  return (
    <form action={setLocaleAction}>
      <div role="group" aria-label={t('language.label')} className="flex items-center gap-1 text-sm">
        {locales.map((locale) => (
          <button
            key={locale}
            type="submit"
            name="locale"
            value={locale}
            lang={locale}
            aria-pressed={locale === active}
            className={`rounded-md px-2 py-1 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              locale === active ? 'bg-accent text-white' : 'text-ink hover:bg-canvas'
            }`}
          >
            {localeNames[locale]}
          </button>
        ))}
      </div>
    </form>
  )
}
