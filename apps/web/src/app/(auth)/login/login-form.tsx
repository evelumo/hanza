'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { TextLink } from '@/components/text-link'
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
    <form onSubmit={onSubmit} className="grid gap-4">
      <h1 className="text-xl leading-7 font-semibold tracking-[-0.01em]">{t('auth.login.title')}</h1>
      <Field label={t('auth.login.email')} name="email" type="email" autoComplete="email" required className="h-9" />
      <Field label={t('auth.login.password')} name="password" type="password" autoComplete="current-password" required className="h-9" />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? t('auth.login.submitting') : t('auth.login.submit')}</SubmitButton>
      <p className="text-sm text-muted-foreground">
        {t('auth.login.noAccount')}{' '}
        <TextLink href="/register" className="underline">
          {t('auth.login.registerLink')}
        </TextLink>
      </p>
    </form>
  )
}
