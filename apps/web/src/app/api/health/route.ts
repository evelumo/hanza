import { getContext } from '@/lib/context'

export const dynamic = 'force-dynamic'

async function check(probe: () => Promise<unknown>): Promise<'ok' | 'down'> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000))
  try {
    await Promise.race([probe(), timeout])
    return 'ok'
  } catch {
    return 'down'
  }
}

export async function GET() {
  const ctx = getContext()
  const [database, queue] = await Promise.all([
    check(() => ctx.db.$queryRaw`SELECT 1`),
    check(() => ctx.queue.ping()),
  ])
  const healthy = database === 'ok' && queue === 'ok'
  return Response.json({ status: healthy ? 'ok' : 'degraded', database, queue }, { status: healthy ? 200 : 503 })
}
