import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { nextCookies } from 'better-auth/next-js'
import { organization } from 'better-auth/plugins'
import { getContext } from './context'

const { db } = getContext()

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    session: {
      create: {
        // An organization is the tenant: every new session starts in the user's first one.
        before: async (session) => {
          const membership = await db.member.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: 'asc' },
          })
          return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } }
        },
      },
    },
  },
  // nextCookies must stay last.
  plugins: [organization(), nextCookies()],
})
