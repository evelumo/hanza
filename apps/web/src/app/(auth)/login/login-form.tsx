'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { authClient } from '@/lib/auth-client'

export function LoginForm() {
  const router = useRouter()
  const t = useT()
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
      setError(t('auth.login.invalid'))
      setPending(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-semibold">{t('auth.login.title')}</h1>
      <Field label={t('auth.login.email')} name="email" type="email" autoComplete="email" required />
      <Field label={t('auth.login.password')} name="password" type="password" autoComplete="current-password" required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? t('auth.login.submitting') : t('auth.login.submit')}</SubmitButton>
      <p className="text-sm text-muted">
        {t('auth.login.noAccount')}{' '}
        <Link href="/register" className="font-medium text-accent underline">
          {t('auth.login.registerLink')}
        </Link>
      </p>
    </form>
  )
}
