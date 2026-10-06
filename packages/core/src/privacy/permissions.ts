import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'

/** Better Auth organization roles allowed to change the Retention period and handle Erasure requests; both cannot be undone. */
const PRIVACY_ROLES = new Set(['owner', 'admin'])

export async function canManagePrivacy(ctx: Context, organizationId: string, userId: string): Promise<boolean> {
  const member = await ctx.db.member.findFirst({ where: { organizationId, userId }, select: { role: true } })
  // Better Auth stores several roles as one comma-separated value.
  return member !== null && member.role.split(',').some((role) => PRIVACY_ROLES.has(role.trim()))
}

/** The system (the retention job) may always; a person must be an owner or admin of the organization. */
export async function assertCanManagePrivacy(ctx: Context, organizationId: string, actor: Actor): Promise<void> {
  if (actor.type === 'system') return
  if (!(await canManagePrivacy(ctx, organizationId, actor.userId))) throw new DomainError('forbidden')
}
