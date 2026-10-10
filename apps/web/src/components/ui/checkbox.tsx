import * as React from 'react'
import { cn } from '@/lib/utils'

/*
 * A native checkbox, drawn with the panel's tokens: it submits with its form without JavaScript, takes
 * `defaultChecked`, and scripts such as "select all" can set `.checked` on it. The tick is a mask, so it
 * follows the theme.
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'peer relative size-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-input bg-card shadow-xs transition-colors',
        'before:absolute before:inset-0 before:bg-primary-foreground before:opacity-0 before:[mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M3.5%208.5l3%203%206-7%27%2F%3E%3C%2Fsvg%3E")_center/contain_no-repeat]',
        'checked:border-primary checked:bg-primary checked:before:opacity-100',
        'indeterminate:border-primary indeterminate:bg-primary indeterminate:before:opacity-100 indeterminate:before:[mask:linear-gradient(black,black)_center/8px_2px_no-repeat]',
        'hover:border-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical dark:bg-input/15 dark:checked:bg-primary',
        className,
      )}
      {...props}
    />
  )
}

export { Checkbox }
