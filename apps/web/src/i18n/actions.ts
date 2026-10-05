'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale } from './config'

/** Works before login (the auth pages have the switcher too), so it does not need a tenant. */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get('locale')
  if (!isLocale(locale)) return
  // Only the server reads the cookie (`request.ts`), so the browser's scripts get no access to it.
  ;(await cookies()).set(LOCALE_COOKIE, locale, {
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  })
  revalidatePath('/', 'layout')
}
