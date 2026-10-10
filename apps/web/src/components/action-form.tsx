'use client'

import { useActionState, useRef, useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useT } from '@/i18n/use-t'
import type { ActionState } from '@/lib/action-state'
import { cn } from '@/lib/utils'
import { FormError, FormSuccess } from './form'

/**
 * Wires a server action to a form: shows its error and an optional success note. With `confirm` (a sentence
 * stating the consequence) the submit first opens a dialog whose confirm button carries the name of the button
 * that was pressed; the form then goes through its server action as usual. Children may be a function of the
 * last result.
 *
 * The notes come after the children. A form that stacks its fields over its buttons passes the buttons as
 * `actions`: they are rendered as a row after the notes, so what the action answered sits between the fields
 * and the button that was pressed, not below it. A form that is one row of controls keeps its button among
 * the children, and the notes follow the row.
 */
export function ActionForm<S extends ActionState = ActionState>({
  action,
  children,
  actions,
  className,
  actionsClassName,
  confirm,
  confirmLabel,
  success,
  id,
}: {
  action: (previous: S, formData: FormData) => Promise<S>
  children: ReactNode | ((state: S) => ReactNode)
  /** The form's buttons, when they follow its fields: a row of their own, after the notes. */
  actions?: ReactNode
  className?: string
  actionsClassName?: string
  confirm?: string
  /** Name of the dialog and of its confirm button; the pressed button's own text when omitted. */
  confirmLabel?: string
  success?: string
  id?: string
}) {
  const t = useT()
  // `Awaited<S>` is `S` for these plain-object states; TypeScript cannot see it through the generic.
  const [state, formAction] = useActionState(
    action as unknown as (previous: Awaited<S>, formData: FormData) => Promise<Awaited<S>>,
    {} as Awaited<S>,
  )
  const form = useRef<HTMLFormElement>(null)
  const submitter = useRef<HTMLElement | null>(null)
  const confirmed = useRef(false)
  const [open, setOpen] = useState(false)
  // Kept while the dialog closes, so its text does not vanish mid-animation.
  const [prompt, setPrompt] = useState({ label: '', destructive: false })

  const error = state.error ?? null
  const done = state.ok && success ? success : null

  return (
    <>
      <form
        ref={form}
        id={id}
        action={formAction}
        className={className}
        onSubmit={(event) => {
          if (!confirm) return
          if (confirmed.current) {
            confirmed.current = false
            return
          }
          // Preventing the submit also keeps React from running the action; confirming submits again.
          event.preventDefault()
          const pressed = (event.nativeEvent as SubmitEvent).submitter
          submitter.current = pressed
          setPrompt({
            label: confirmLabel || pressed?.textContent?.trim() || t('common.confirm'),
            destructive: pressed?.dataset.variant?.startsWith('destructive') ?? false,
          })
          setOpen(true)
        }}
      >
        {typeof children === 'function' ? children(state) : children}
        {/* Whatever the form's layout is, the notes take a whole row of it: of a grid's columns, of a wrapping flex row. */}
        {error || done ? (
          <div className="col-span-full grid w-full gap-2">
            <FormError message={error} />
            <FormSuccess message={done} />
          </div>
        ) : null}
        {actions ? <div className={cn('flex flex-wrap items-center gap-2', actionsClassName)}>{actions}</div> : null}
      </form>
      {confirm ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent
            // Focus goes back to the button that asked, also where a click did not focus it (Safari).
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              submitter.current?.focus()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{prompt.label}</AlertDialogTitle>
              <AlertDialogDescription>{confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant={prompt.destructive ? 'destructive' : 'default'}
                onClick={() => {
                  confirmed.current = true
                  // With the pressed button as submitter, so its name and value reach the action.
                  const pressed = submitter.current
                  form.current?.requestSubmit(pressed instanceof HTMLButtonElement || pressed instanceof HTMLInputElement ? pressed : null)
                }}
              >
                {prompt.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  )
}
