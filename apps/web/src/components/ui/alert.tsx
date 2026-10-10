import * as React from 'react'
import { cn } from '@/lib/utils'
import { toneSurfaceClass, type Tone } from '@/components/tone'

/**
 * A toned box for a message inside the page. It has no role of its own: pass `role="alert"` for an error that
 * just happened, `role="status"` for a result, nothing for standing information (see `Notice`).
 */
function Alert({ className, tone = 'neutral', ...props }: React.ComponentProps<'div'> & { tone?: Tone }) {
  return (
    <div
      data-slot="alert"
      data-tone={tone}
      className={cn(
        'grid grid-cols-[1fr] items-start gap-x-2.5 gap-y-1 rounded-lg border px-3 py-2.5 text-sm has-[>svg]:grid-cols-[auto_1fr] [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        toneSurfaceClass[tone],
        className,
      )}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('font-semibold [svg~&]:col-start-2', className)} {...props} />
}

// Body text on a tinted surface takes the foreground colour, never grey.
function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('grid gap-2 text-foreground [svg~&]:col-start-2', className)} {...props} />
}

export { Alert, AlertTitle, AlertDescription }
