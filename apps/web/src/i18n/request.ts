import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { catalogues } from './catalogues'
import { LOCALE_COOKIE, PANEL_TIME_ZONE } from './config'
import { resolveLocale } from './resolve-locale'

// No locale in the URL: this is a panel behind a login, so the choice lives in a cookie.
export default getRequestConfig(async () => {
  const locale = resolveLocale({
    cookie: (await cookies()).get(LOCALE_COOKIE)?.value,
    acceptLanguage: (await headers()).get('accept-language'),
  })
  return { locale, messages: catalogues[locale], timeZone: PANEL_TIME_ZONE }
})
