import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
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
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
