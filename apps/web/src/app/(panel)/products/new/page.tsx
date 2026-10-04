import Link from 'next/link'
import { linkClass } from '@/components/section'
import { requireTenant } from '@/lib/session'
import { NewProductForm } from './new-product-form'

export const dynamic = 'force-dynamic'

export default async function NewProductPage() {
  await requireTenant()
  return (
    <div className="max-w-md space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← Produkty
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Dodaj produkt</h1>
      </div>
      <div className="rounded-lg border border-line bg-white p-5">
        <NewProductForm />
      </div>
    </div>
  )
}
