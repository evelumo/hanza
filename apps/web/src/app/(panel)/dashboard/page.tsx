import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { PingButton } from './ping-button'

export const dynamic = 'force-dynamic'

const dateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'medium' })

export default async function DashboardPage() {
  const { organizationId } = await requireTenant()
  const events = await getContext().db.eventLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pulpit</h1>
        <p className="mt-1 text-muted">Konektory, zamówienia i produkty pojawią się tu w kolejnych etapach.</p>
      </div>

      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-semibold">Ostatnie zdarzenia</h2>
            <p className="text-sm text-muted">Zadanie testowe przechodzi przez kolejkę i worker, a wynik trafia tutaj.</p>
          </div>
          <PingButton />
        </div>
        {events.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">Brak zdarzeń. Wyślij zadanie testowe, żeby sprawdzić, czy worker działa.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <code className="font-mono">{event.type}</code>
                <time dateTime={event.createdAt.toISOString()} className="text-muted">
                  {dateFormat.format(event.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
