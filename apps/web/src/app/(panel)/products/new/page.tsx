import type { Metadata } from 'next'
import Link from 'next/link'
import { linkClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { requireTenant } from '@/lib/session'
import { NewProductForm } from './new-product-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.new.title') }
}

export default async function NewProductPage() {
  await requireTenant()
  const t = await getT()
  return (
    <div className="max-w-md space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← {t('products.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('products.new.title')}</h1>
      </div>
      <div className="rounded-lg border border-line bg-white p-5">
        <NewProductForm />
      </div>
    </div>
  )
}
