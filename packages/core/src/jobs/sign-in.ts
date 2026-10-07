import { runSignInPoll, runSignInStart } from '../connections/sign-in-flow'
import { defineJob } from '../jobs'
import { signInPollRef, signInStartRef } from './refs'

/** Asks the Channel for a device code; the payload carries ids only, the code is stored sealed. */
export const signInStartJob = defineJob({
  ...signInStartRef,
  async handler(ctx, { organizationId, signInId }, run) {
    await runSignInStart(ctx, organizationId, signInId, run)
  },
})

/** Polls the Channel at its interval until the person approves or denies the sign-in, or the code expires. */
export const signInPollJob = defineJob({
  ...signInPollRef,
  async handler(ctx, { organizationId, signInId }) {
    await runSignInPoll(ctx, organizationId, signInId)
  },
})
