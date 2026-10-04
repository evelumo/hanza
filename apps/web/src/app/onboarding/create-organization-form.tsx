'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, SubmitButton } from '@/components/form'
import { authClient } from '@/lib/auth-client'

function toSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'firma'}-${crypto.randomUUID().slice(0, 6)}`
}

export function CreateOrganizationForm() {
  const router = useRouter()
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
      setError(error.message ?? 'Nie udało się utworzyć firmy.')
      setPending(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Dodaj swoją firmę</h1>
        <p className="mt-1 text-sm text-muted">Wszystkie zamówienia, produkty i połączenia będą należeć do tej firmy.</p>
      </div>
      <Field label="Nazwa firmy" name="name" required />
      <FormError message={error} />
      <SubmitButton disabled={pending}>{pending ? 'Zapisywanie…' : 'Dalej'}</SubmitButton>
    </form>
  )
}
