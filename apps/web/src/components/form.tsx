'use client'

import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useFormStatus } from 'react-dom'
import { useT } from '@/i18n/use-t'
import { buttonClass, type ButtonVariant } from './button-class'

const control =
  'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-base font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

// The hint and the error sit outside the <label> and are linked as its description, so the
// control's accessible name is the label alone (what screen readers announce and tests look up).
export function Field({ label, error, hint, ...input }: { label: string; error?: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const generatedId = useId()
  const id = input.id ?? generatedId
  const note = error ?? hint
  return (
    <div className="block text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className={`${control} ${error ? 'border-red-400' : 'border-line'}`}
      />
      {note ? (
        <span id={`${id}-note`} className={`mt-1 block text-xs font-normal ${error ? 'text-red-700' : 'text-muted'}`}>
          {note}
        </span>
      ) : null}
    </div>
  )
}

export function Select({
  label,
  error,
  children,
  ...select
}: { label: string; error?: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const generatedId = useId()
  const id = select.id ?? generatedId
  return (
    <div className="block text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      <select
        {...select}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-note` : undefined}
        className={`${control} ${error ? 'border-red-400' : 'border-line'}`}
      >
        {children}
      </select>
      {error ? (
        <span id={`${id}-note`} className="mt-1 block text-xs font-normal text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export function SubmitButton({ children, ...button }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...button}
      className="w-full rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong disabled:opacity-60"
    >
      {children}
    </button>
  )
}

/** A submit button that disables itself while its form's action runs. */
export function ActionButton({
  variant = 'primary',
  pendingLabel,
  children,
  ...button
}: { variant?: ButtonVariant; pendingLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus()
  const t = useT()
  return (
    <button type="submit" {...button} disabled={pending || button.disabled} className={buttonClass(variant)}>
      {pending ? (pendingLabel ?? t('common.saving')) : children}
    </button>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  )
}
