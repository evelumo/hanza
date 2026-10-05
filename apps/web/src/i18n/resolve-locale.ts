import { defaultLocale, isLocale, type Locale } from './config'

// A real header has a handful of entries; the cap keeps a hostile one cheap to parse.
const MAX_ENTRIES = 32

/** The best supported locale of an `Accept-Language` header (`pl-PL,pl;q=0.9,en;q=0.8`), or null. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null
  const candidates = header
    .split(',')
    .slice(0, MAX_ENTRIES)
    .flatMap((entry, index) => {
      const [range = '', ...params] = entry.split(';').map((part) => part.trim())
      const qParam = params.find((param) => /^q=/i.test(param))
      const quality = qParam ? Number(qParam.slice(2)) : 1
      if (!range || range === '*' || !Number.isFinite(quality) || quality <= 0) return []
      return [{ language: range.split('-')[0]?.toLowerCase() ?? '', quality, index }]
    })
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
  for (const { language } of candidates) if (isLocale(language)) return language
  return null
}

/** Cookie (an explicit choice) wins over the browser's languages; anything unsupported falls back to English. */
export function resolveLocale({ cookie, acceptLanguage }: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(cookie)) return cookie
  return matchAcceptLanguage(acceptLanguage) ?? defaultLocale
}
