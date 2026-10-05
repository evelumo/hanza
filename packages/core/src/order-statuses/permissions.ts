import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'

/** Better Auth organization roles allowed to manage Order statuses and Status mappings. */
const MANAGER_ROLES = new Set(['owner', 'admin'])

export async function canManageOrderStatuses(ctx: Context, organizationId: string, userId: string): Promise<boolean> {
  const member = await ctx.db.member.findFirst({ where: { organizationId, userId }, select: { role: true } })
  // Better Auth stores several roles as one comma-separated value.
  return member !== null && member.role.split(',').some((role) => MANAGER_ROLES.has(role.trim()))
}

/** The system may always; a person must be an owner or admin of the organization. */
export async function assertCanManageOrderStatuses(ctx: Context, organizationId: string, actor: Actor): Promise<void> {
  if (actor.type === 'system') return
  if (!(await canManageOrderStatuses(ctx, organizationId, actor.userId))) throw new DomainError('forbidden')
}
