'use client'

import { useActionState, type ReactNode } from 'react'
import type { ActionState } from '@/lib/action-state'
import { FormError } from './form'


/**
 * Wires a server action to a form: shows its error and an optional success note, and asks for
 * confirmation first when `confirm` is set. Children may be a function of the last result.
 */
export function ActionForm<S extends ActionState = ActionState>({
  action,
  children,
  className,
  confirm,
  success,
  id,
}: {
  action: (previous: S, formData: FormData) => Promise<S>
  children: ReactNode | ((state: S) => ReactNode)
  className?: string
  confirm?: string
  success?: string
  id?: string
}) {
  // `Awaited<S>` is `S` for these plain-object states; TypeScript cannot see it through the generic.
  const [state, formAction] = useActionState(
    action as unknown as (previous: Awaited<S>, formData: FormData) => Promise<Awaited<S>>,
    {} as Awaited<S>,
  )
  return (
    <form
      id={id}
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
    >
      {typeof children === 'function' ? children(state) : children}
      <FormError message={state.error ?? null} />
      {state.ok && success ? (
        <p role="status" className="text-sm text-green-800">
          {success}
        </p>
      ) : null}
    </form>
  )
}
