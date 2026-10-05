import Link from 'next/link'
import { linkClass } from '@/components/section'

export default function PanelNotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Nie znaleziono</h1>
      <p className="text-muted">Taka strona nie istnieje albo nie masz do niej dostępu.</p>
      <Link href="/dashboard" className={linkClass}>
        Wróć do pulpitu
      </Link>
    </div>
  )
}
