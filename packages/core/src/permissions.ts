import type { Actor } from './actor'
import type { Context } from './context'
import { DomainError } from './errors'

/**
 * Better Auth organization roles that may change how the organization works: its Order statuses and Status mappings,
 * the Retention period and Erasure requests (the last two cannot be undone). Every member can still work with Orders.
 */
const MANAGER_ROLES = new Set(['owner', 'admin'])

export async function canManageOrganization(ctx: Context, organizationId: string, userId: string): Promise<boolean> {
  const member = await ctx.db.member.findFirst({ where: { organizationId, userId }, select: { role: true } })
  // Better Auth stores several roles as one comma-separated value.
  return member !== null && member.role.split(',').some((role) => MANAGER_ROLES.has(role.trim()))
}

/** The system (a job such as the retention sweep) may always; a person must be an owner or admin of the organization. */
export async function assertCanManageOrganization(ctx: Context, organizationId: string, actor: Actor): Promise<void> {
  if (actor.type === 'system') return
  if (!(await canManageOrganization(ctx, organizationId, actor.userId))) throw new DomainError('forbidden')
}
