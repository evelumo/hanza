import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { Tone } from './tone'

const toneIcon: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  attention: CircleAlert,
  critical: OctagonAlert,
}

/**
 * Standing information about the thing on the page that a person should not miss: an Order that needs
 * attention, a Connection that must sign in again. With a `title` it is a region named by it. Not for the
 * result of an action (that is `FormError` / `FormSuccess`). A notice that appears or changes while the page is
 * open (a sign-in that is waiting) takes `role="status"` or `aria-live`, so a screen reader says it.
 */
export function Notice({
  tone = 'info',
  title,
  icon,
  actions,
  role,
  'aria-live': ariaLive,
  children,
}: {
  tone?: Tone
  title?: string
  icon?: LucideIcon
  actions?: ReactNode
  role?: 'status' | 'alert'
  'aria-live'?: 'polite' | 'assertive'
  children?: ReactNode
}) {
  const headingId = useId()
  const Icon = icon ?? toneIcon[tone]
  const body = (
    <Alert tone={tone} role={role} aria-live={ariaLive}>
      <Icon aria-hidden="true" />
      {title ? (
        <AlertTitle>
          <h2 id={headingId}>{title}</h2>
        </AlertTitle>
      ) : null}
      {children ? <AlertDescription>{children}</AlertDescription> : null}
      {actions ? <div className="col-start-2 mt-1 flex flex-wrap gap-2">{actions}</div> : null}
    </Alert>
  )
  return title ? <section aria-labelledby={headingId}>{body}</section> : body
}
