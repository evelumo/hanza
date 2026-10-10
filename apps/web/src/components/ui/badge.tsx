import * as React from 'react'
import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toneSurfaceClass, type Tone } from '@/components/tone'

// Each tone has its own shape, so a badge reads without its colour.
const toneIcon: Record<Tone, LucideIcon | null> = {
  neutral: null,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  attention: CircleAlert,
  critical: OctagonAlert,
}

/**
 * A pill that states something's state in words. `icon` replaces the tone's own icon; `null` leaves it out,
 * which is only right for a neutral tag.
 */
function Badge({
  className,
  tone = 'neutral',
  icon,
  children,
  ...props
}: React.ComponentProps<'span'> & { tone?: Tone; icon?: LucideIcon | null }) {
  const Icon = icon === undefined ? toneIcon[tone] : icon
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={cn(
        'inline-flex h-[1.375rem] w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap has-[>svg]:pl-1.5 [&>svg]:size-3.5 [&>svg]:shrink-0',
        // `own-baseline` (globals.css) with the gap it has to take back: a badge sits level in a line of text.
        'own-baseline before:-mr-1',
        toneSurfaceClass[tone],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

export { Badge }
