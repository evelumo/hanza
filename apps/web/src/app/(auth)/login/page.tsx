'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { authClient } from '@/lib/auth-client'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    if (error) {
      setError('Nieprawidłowy e-mail lub hasło.')
      setPending(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-semibold">Zaloguj się</h1>
      <Field label="E-mail" name="email" type="email" autoComplete="email" required />
      <Field label="Hasło" name="password" type="password" autoComplete="current-password" required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? 'Logowanie…' : 'Zaloguj się'}</SubmitButton>
      <p className="text-sm text-muted">
        Nie masz konta?{' '}
        <Link href="/register" className="font-medium text-accent underline">
          Zarejestruj się
        </Link>
      </p>
    </form>
  )
}
