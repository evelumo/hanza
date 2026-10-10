import * as React from 'react'
import { cn } from '@/lib/utils'
import { controlClass } from '@/components/ui/input'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(controlClass, 'flex field-sizing-content min-h-16 py-1.5', className)} {...props} />
}

export { Textarea }
