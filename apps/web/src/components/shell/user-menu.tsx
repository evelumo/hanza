'use client'

import { ChevronsUpDown, LogOut } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { useSignOut } from '@/components/sign-out-button'
import { localeNames, locales } from '@/i18n/config'
import { useT } from '@/i18n/use-t'
import { themes, usePreferences } from './use-preferences'

export function UserMenu({ name, email }: { name: string; email: string }) {
  const t = useT()
  const { isMobile } = useSidebar()
  const { locale, setLocale, theme, setTheme } = usePreferences()
  const signOut = useSignOut()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Named in so many words: the avatar's initial is a picture, and must not open the name ("A Anna …"). */}
            <SidebarMenuButton size="lg" aria-label={name ? `${name}, ${email}` : email} className="data-[state=open]:bg-sidebar-accent">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-sm font-semibold uppercase"
              >
                {(name || email).slice(0, 1)}
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{email}</span>
              </span>
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? 'top' : 'right'} align="end" sideOffset={8} className="w-60">
            <DropdownMenuLabel className="truncate text-sm font-medium text-foreground">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel id="user-menu-language">{t('language.label')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup aria-labelledby="user-menu-language" value={locale} onValueChange={setLocale}>
              {locales.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} lang={option}>
                  {localeNames[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel id="user-menu-theme">{t('shell.theme.label')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup aria-labelledby="user-menu-theme" value={theme} onValueChange={setTheme}>
              {themes.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {t(`shell.theme.${option}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut aria-hidden="true" />
              {t('auth.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
