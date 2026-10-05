'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { authClient } from '@/lib/auth-client'
import { authErrorKey } from '@/lib/auth-errors'

export function RegisterForm() {
  const router = useRouter()
  const t = useT()
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
      setError(t(authErrorKey(error.code, 'auth.register.failed')))
      setPending(false)
      return
    }
    router.push('/onboarding')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-semibold">{t('auth.register.title')}</h1>
      <Field label={t('auth.register.name')} name="name" autoComplete="name" required />
      <Field label={t('auth.login.email')} name="email" type="email" autoComplete="email" required />
      <Field label={t('auth.login.password')} name="password" type="password" autoComplete="new-password" minLength={8} required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? t('auth.register.submitting') : t('auth.register.submit')}</SubmitButton>
      <p className="text-sm text-muted">
        {t('auth.register.haveAccount')}{' '}
        <Link href="/login" className="font-medium text-accent underline">
          {t('auth.register.loginLink')}
        </Link>
      </p>
    </form>
  )
}
