'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { authClient } from '@/lib/auth-client'

export default function RegisterPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    if (error) {
      setError(error.message ?? 'Nie udało się utworzyć konta.')
      setPending(false)
      return
    }
    router.push('/onboarding')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-semibold">Utwórz konto</h1>
      <Field label="Imię i nazwisko" name="name" autoComplete="name" required />
      <Field label="E-mail" name="email" type="email" autoComplete="email" required />
      <Field label="Hasło" name="password" type="password" autoComplete="new-password" minLength={8} required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? 'Tworzenie konta…' : 'Utwórz konto'}</SubmitButton>
      <p className="text-sm text-muted">
        Masz już konto?{' '}
        <Link href="/login" className="font-medium text-accent underline">
          Zaloguj się
        </Link>
      </p>
    </form>
  )
}
