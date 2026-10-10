'use client'

import { Languages, LoaderCircle, Monitor, Moon, Package, Plus, Search, Sun, type LucideIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Identifier } from '@/components/identifier'
import { Button } from '@/components/ui/button'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { localeNames, locales } from '@/i18n/config'
import type { MessageKey } from '@/i18n/types'
import { useT } from '@/i18n/use-t'
import { navigation } from './navigation'
import { PALETTE_MAX_QUERY, PALETTE_MIN_QUERY, type PaletteResults } from './search'
import { searchPaletteAction } from './search-action'
import { themes, usePreferences, type ThemeChoice } from './use-preferences'

const actions: Array<{ href: string; label: MessageKey }> = [
  { href: '/products/new', label: 'shell.command.addProduct' },
  { href: '/connections/new', label: 'shell.command.addConnection' },
  { href: '/families/new', label: 'shell.command.addFamily' },
  { href: '/warehouses', label: 'shell.command.addWarehouse' },
]

const themeIcon: Record<ThemeChoice, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

// Plain "contains" matching, done here and not by cmdk: its own is fuzzy (it offers Product families to someone
// typing "mug") and it re-orders the groups by score, which would move the search hand-off off the last place.
const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replaceAll('ł', 'l')
const matches = (search: string, ...texts: Array<string | undefined>) => !search || fold(texts.join(' ')).includes(fold(search))

const noSubscription = () => () => {}
// The server cannot know the platform, so it prints Ctrl; a Mac corrects the hint when it hydrates.
const isApple = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** Long enough to skip the letters of a word being typed, short enough to feel direct. */
const LOOKUP_DELAY_MS = 200

const SEARCH_VALUE = 'search'
const productValue = (id: string) => `product:${id}`

type Lookup =
  | { state: 'idle' }
  /** `products` are those of the last answer, shown (as far as they still match) until the new one is in. */
  | { state: 'pending'; products: PaletteResults['products'] }
  | { state: 'done' | 'failed'; query: string; products: PaletteResults['products'] }

const hintKeyClass = 'rounded-sm border border-border bg-muted px-1 font-sans text-xs'

/**
 * The search button of the top bar and the palette it opens (also with Cmd/Ctrl+K): Products found by name or
 * SKU while typing, the panel's pages, the actions that create something, and the preferences.
 */
export function CommandPalette() {
  const t = useT()
  const router = useRouter()
  const { setLocale, setTheme } = usePreferences()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const apple = useSyncExternalStore(noSubscription, isApple, () => false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const search = query.trim().slice(0, PALETTE_MAX_QUERY)

  useEffect(() => {
    if (!open || search.length < PALETTE_MIN_QUERY) {
      setLookup({ state: 'idle' })
      return
    }
    setLookup((current) => ({ state: 'pending', products: current.state === 'idle' ? [] : current.products }))
    let stale = false
    const timer = setTimeout(async () => {
      try {
        const { products } = await searchPaletteAction(search)
        if (stale) return
        setLookup({ state: 'done', query: search, products })
        // With nothing else to choose, Enter was on the hand-off to the Products list: a direct hit takes its place.
        if (products[0]) setSelected((current) => (current === SEARCH_VALUE ? productValue(products[0]!.id) : current))
      } catch {
        if (!stale) setLookup({ state: 'failed', query: search, products: [] })
      }
    }, LOOKUP_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [open, search])

  function change(next: boolean) {
    setOpen(next)
    if (next) return
    setQuery('')
    // The next visit starts on the first item, not where this one ended.
    setSelected('')
  }

  function run(effect: () => void) {
    change(false)
    effect()
  }

  const go = (href: string) => () => run(() => router.push(href))

  const shownActions = actions.map((action) => ({ ...action, text: t(action.label) })).filter((action) => matches(search, action.text))
  const destinations = navigation
    .flatMap((group) =>
      group.items.flatMap((item) => {
        const keywords = group.label ? t(group.label) : undefined
        // A destination with pages of its own (Settings) is listed page by page.
        if (item.pages) {
          return item.pages.map((page) => ({ href: page.href, icon: item.icon, text: t('shell.command.subPage', { section: t(item.label), page: t(page.label) }), keywords }))
        }
        return [{ href: item.href, icon: item.icon, text: t(item.label), keywords }]
      }),
    )
    .filter((destination) => matches(search, destination.text, destination.keywords))
  const preferences = [
    ...themes.map((theme) => ({ key: `theme:${theme}`, icon: themeIcon[theme], text: t('shell.command.theme', { theme: t(`shell.theme.${theme}`) }), lang: undefined, apply: () => setTheme(theme) })),
    ...locales.map((locale) => ({
      key: `language:${locale}`,
      icon: Languages,
      text: t('shell.command.language', { language: localeNames[locale] }),
      lang: locale,
      apply: () => setLocale(locale),
    })),
  ].filter((preference) => matches(search, preference.text))
  // An answer to an earlier text is shown only as far as it fits the text that is there now.
  const products = lookup.state === 'idle' ? [] : lookup.products.filter((product) => matches(search, product.name, product.sku))
  const answered = (lookup.state === 'done' || lookup.state === 'failed') && lookup.query === search

  const actionGroup =
    shownActions.length > 0 ? (
      <CommandGroup heading={t('shell.command.actions')}>
        {shownActions.map((action) => (
          <CommandItem key={action.href} value={`action:${action.href}`} onSelect={go(action.href)}>
            <Plus aria-hidden="true" />
            {action.text}
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
        className="justify-start gap-2 px-2.5 font-normal before:-mr-2 text-muted-foreground max-sm:w-8 max-sm:justify-center max-sm:px-0 sm:w-56"
      >
        <Search aria-hidden="true" />
        <span className="max-sm:sr-only">{t('shell.search.label')}</span>
        <kbd aria-hidden="true" className="ml-auto rounded-sm border border-border bg-muted px-1 font-sans text-xs max-sm:hidden">
          {apple ? '⌘K' : 'Ctrl K'}
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={change}
        title={t('shell.command.title')}
        description={t('shell.command.description')}
        commandProps={{ shouldFilter: false, value: selected, onValueChange: setSelected, label: t('shell.command.title') }}
      >
        <CommandInput value={query} onValueChange={setQuery} maxLength={PALETTE_MAX_QUERY} placeholder={t('shell.command.placeholder')} />
        <CommandList label={t('shell.command.results')}>
          <CommandEmpty>{t('shell.command.empty')}</CommandEmpty>
          {/*
            Opened, the palette shows the actions that create something before the ten places the sidebar already
            lists. Once there is text, a place it names comes first: "orders" and Enter goes to Orders.
          */}
          {search ? null : actionGroup}
          {destinations.length > 0 ? (
            <CommandGroup heading={t('shell.command.goTo')}>
              {destinations.map((destination) => (
                <CommandItem key={destination.href} value={`go:${destination.href}`} onSelect={go(destination.href)}>
                  <destination.icon aria-hidden="true" />
                  {destination.text}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {search ? actionGroup : null}
          {/* After the pages and actions, which are there at once: an answer that arrives late moves nothing above it. */}
          {lookup.state !== 'idle' ? (
            <CommandGroup heading={t('shell.command.products')}>
              {products.map((product) => (
                <CommandItem key={product.id} value={productValue(product.id)} onSelect={go(`/products/${product.id}`)}>
                  <Package aria-hidden="true" />
                  <span className="min-w-0 truncate">{product.name}</span>
                  <Identifier className="ml-auto pl-3 text-muted-foreground">{product.sku}</Identifier>
                </CommandItem>
              ))}
              {lookup.state === 'pending' ? (
                <p role="status" className="flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  {t('shell.command.searching')}
                </p>
              ) : answered && products.length === 0 ? (
                <p role="status" className="flex min-h-8 items-center px-2 py-1 text-sm text-muted-foreground">
                  {lookup.state === 'failed' ? t('shell.command.searchFailed') : t('shell.command.noProducts', { query: search })}
                </p>
              ) : null}
            </CommandGroup>
          ) : null}
          {preferences.length > 0 ? (
            <CommandGroup heading={t('shell.command.preferences')}>
              {preferences.map((preference) => (
                <CommandItem key={preference.key} value={preference.key} onSelect={() => run(preference.apply)}>
                  <preference.icon aria-hidden="true" />
                  <span lang={preference.lang}>{preference.text}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {search ? (
            <CommandGroup heading={t('shell.command.search')}>
              {/* Always offered while there is text, and last, so Enter takes a page, an action or a Product that matches before it takes the search. */}
              <CommandItem value={SEARCH_VALUE} onSelect={go(`/products?q=${encodeURIComponent(search)}`)}>
                <Search aria-hidden="true" />
                {t('shell.command.searchProducts', { query: search })}
              </CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
        {/* For a keyboard; a phone has none. */}
        <p className="flex items-center gap-x-4 border-t border-border px-3 py-2 text-xs text-muted-foreground max-sm:hidden">
          <span>
            <kbd className={hintKeyClass}>↑</kbd> <kbd className={hintKeyClass}>↓</kbd> {t('shell.command.hintMove')}
          </span>
          <span>
            <kbd className={hintKeyClass}>↵</kbd> {t('shell.command.hintOpen')}
          </span>
          <span>
            <kbd className={hintKeyClass}>Esc</kbd> {t('shell.command.hintClose')}
          </span>
        </p>
      </CommandDialog>
    </>
  )
}
