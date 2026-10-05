import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { catalogues } from '@/i18n/catalogues'
import { clientMessages } from '@/i18n/client-messages'
import { getActiveLocale, getT } from '@/i18n/server'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: { default: 'Hanza', template: '%s · Hanza' }, description: t('meta.description') }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getActiveLocale()
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider messages={clientMessages(catalogues[locale])}>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
