import * as React from 'react'
import { cn } from '@/lib/utils'

/** The type of a label's line, for what has to be exactly as high as one without being one. */
export const labelLineClass = 'text-sm leading-5 font-medium'

// A plain <label>: nothing here needs Radix, and it keeps the form kit usable from server components.
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(labelLineClass, 'text-foreground select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50', className)}
      {...props}
    />
  )
}

export { Label }
