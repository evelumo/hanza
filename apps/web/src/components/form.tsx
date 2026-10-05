'use client'

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useFormStatus } from 'react-dom'
import { useT } from '@/i18n/use-t'
import { buttonClass, type ButtonVariant } from './button-class'

const control =
  'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-base font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export function Field({ label, error, hint, ...input }: { label: string; error?: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <input {...input} aria-invalid={error ? true : undefined} className={`${control} ${error ? 'border-red-400' : 'border-line'}`} />
      {hint && !error ? <span className="mt-1 block text-xs font-normal text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs font-normal text-red-700">{error}</span> : null}
    </label>
  )
}

export function Select({
  label,
  error,
  children,
  ...select
}: { label: string; error?: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <select {...select} aria-invalid={error ? true : undefined} className={`${control} ${error ? 'border-red-400' : 'border-line'}`}>
        {children}
      </select>
      {error ? <span className="mt-1 block text-xs font-normal text-red-700">{error}</span> : null}
    </label>
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
