import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'

export function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <input
        {...input}
        className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2 text-base font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
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

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  )
}
