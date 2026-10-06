import { defineJob } from '../jobs'
import { finishOrderStatusDeletion } from '../order-statuses/delete'
import { orderStatusesDeleteRef } from './refs'

/** Moves a status's Orders to its replacement and deletes it; retried while something still references it. */
export const orderStatusesDeleteJob = defineJob({
  ...orderStatusesDeleteRef,
  async handler(ctx, { organizationId, statusId, actor }) {
    const { moved } = await finishOrderStatusDeletion(ctx, organizationId, statusId, actor)
    ctx.log.info('order status deletion run', { organizationId, statusId, moved })
  },
})
