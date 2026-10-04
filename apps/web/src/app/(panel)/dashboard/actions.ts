'use server'

import { systemPingJob } from '@hanza/core'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'

export async function enqueuePing(): Promise<void> {
  const { user, organizationId } = await requireTenant()
  await getContext().queue.enqueue(systemPingJob, { organizationId, requestedBy: user.email })
}
