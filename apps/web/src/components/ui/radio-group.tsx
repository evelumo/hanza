import * as React from 'react'
import { cn } from '@/lib/utils'

// Native radios for the same reasons as Checkbox: they submit without JavaScript and group by `name`.
function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div role="radiogroup" data-slot="radio-group" className={cn('grid gap-3', className)} {...props} />
}

function RadioGroupItem({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="radio"
      data-slot="radio-group-item"
      className={cn(
        'peer relative size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-input bg-card shadow-xs transition-colors',
        'before:absolute before:inset-[3px] before:rounded-full before:bg-primary-foreground before:opacity-0',
        'checked:border-primary checked:bg-primary checked:before:opacity-100',
        'hover:border-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical dark:bg-input/15 dark:checked:bg-primary',
        className,
      )}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem }
