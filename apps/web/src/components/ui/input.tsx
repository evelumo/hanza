import * as React from 'react'
import { cn } from '@/lib/utils'

/** Shared by Input, Textarea and NativeSelect, so every text control has one height, border and invalid state. */
export const controlClass =
  'w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-base text-foreground shadow-xs transition-colors placeholder:text-muted-foreground hover:border-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical aria-invalid:hover:border-critical md:text-sm dark:bg-input/15'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        controlClass,
        'h-8 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
