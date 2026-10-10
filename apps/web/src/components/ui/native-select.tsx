import * as React from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { controlClass } from '@/components/ui/input'

// A native <select>: it works without JavaScript and opens the platform's own picker on touch devices.
// `className` sizes the box (the select fills it); `selectClassName` reaches the <select> itself.
function NativeSelect({
  className,
  selectClassName,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default'; selectClassName?: string }) {
  return (
    <div className={cn('relative w-full has-[select:disabled]:opacity-50', className)} data-slot="native-select-wrapper">
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(controlClass, 'h-8 cursor-pointer appearance-none pr-8 data-[size=sm]:h-7 data-[size=sm]:md:text-meta', selectClassName)}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  )
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return <option data-slot="native-select-option" className={cn('bg-[Canvas] text-[CanvasText]', className)} {...props} />
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return <optgroup data-slot="native-select-optgroup" className={cn('bg-[Canvas] text-[CanvasText]', className)} {...props} />
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
