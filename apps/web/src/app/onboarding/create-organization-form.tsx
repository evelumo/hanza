'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { authClient } from '@/lib/auth-client'
import { authErrorKey } from '@/lib/auth-errors'

function toSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // NFKD leaves the Polish l with stroke whole, so it is mapped by hand.
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'company'}-${crypto.randomUUID().slice(0, 6)}`
}

export function CreateOrganizationForm() {
  const router = useRouter()
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name')).trim()
    setPending(true)
    setError(null)
    // Creating an organization also makes it the active one for this session.
    const { error } = await authClient.organization.create({ name, slug: toSlug(name) })
    if (error) {
      setError(t(authErrorKey(error.code, 'auth.onboarding.failed')))
      setPending(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('auth.onboarding.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('auth.onboarding.description')}</p>
      </div>
      <Field label={t('auth.onboarding.name')} name="name" required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? t('common.saving') : t('auth.onboarding.submit')}</SubmitButton>
    </form>
  )
}
