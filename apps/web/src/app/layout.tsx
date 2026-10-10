import '@fontsource-variable/inter/wght.css'
import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { ThemeProvider } from '@/components/shell/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { catalogues } from '@/i18n/catalogues'
import { clientMessages } from '@/i18n/client-messages'
import { getActiveLocale, getT } from '@/i18n/server'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: { default: 'Hanza', template: '%s · Hanza' }, description: t('meta.description') }
}

// The browser's own chrome takes the canvas colour of the system's theme (`--background` in globals.css).
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f1f1' },
    { media: '(prefers-color-scheme: dark)', color: '#171717' },
  ],
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getActiveLocale()
  return (
    // The theme class is set on <html> by a script before React hydrates, so the attributes differ on purpose.
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-svh antialiased">
        <ThemeProvider>
          <NextIntlClientProvider messages={clientMessages(catalogues[locale])}>
            <TooltipProvider>{children}</TooltipProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
