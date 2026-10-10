import type { ReactNode } from 'react'
import { LanguageSwitcher } from '@/components/language-switcher'
import { BrandMark } from '@/components/shell/brand-mark'
import { Card } from '@/components/ui/card'

/** The frame of the pages outside the panel (sign in, register, onboarding): one centred card on the canvas. */
export function AuthShell({ footer, children }: { footer?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center justify-center gap-2.5">
          <BrandMark className="size-8 rounded-lg" />
          <span className="text-lg font-semibold tracking-[-0.01em]">Hanza</span>
        </div>
        <Card className="p-6">{children}</Card>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <LanguageSwitcher />
          {footer}
        </div>
      </div>
    </main>
  )
}
