import { useT } from '@/i18n/use-t'
import { cn } from '@/lib/utils'

/** A value that is not there (no SKU, no family, no result yet): a dash to the eye, words to a screen reader. */
export function NoValue({ className }: { className?: string }) {
  const t = useT()
  return (
    <span className={cn('text-muted-foreground', className)}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t('common.noValue')}</span>
    </span>
  )
}
