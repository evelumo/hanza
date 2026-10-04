import Link from 'next/link'
import { linkClass } from '@/components/section'

// Unmatched URLs are rendered here, outside the panel layout, so this one needs its own centred wrapper.
export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-2 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Nie znaleziono</h1>
      <p className="text-muted">Taka strona nie istnieje.</p>
      <Link href="/dashboard" className={linkClass}>
        Wróć do panelu
      </Link>
    </main>
  )
}
