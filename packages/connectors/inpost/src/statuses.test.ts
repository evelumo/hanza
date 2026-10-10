import { readFile } from 'node:fs/promises'
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { INPOST_STATUSES, PURCHASE_STATUSES } from './statuses'

// `GET /v1/statuses?lang=en_GB` as production answered on 2026-10-10 (the sandbox lists the same names).
const liveSchema = z.object({ items: z.array(z.object({ name: z.string().min(1), title: z.string(), description: z.string() })) })
const liveText = await readFile(new URL('./fixtures/statuses.json', import.meta.url), 'utf8')
const live = liveSchema.parse(JSON.parse(liveText)).items.map((item) => item.name)

const namesOf = (status: ShipmentStatus | null) =>
  Object.entries(INPOST_STATUSES)
    .filter(([, translated]) => translated === status)
    .map(([name]) => name)
    .sort()

describe('the InPost status table', () => {
  it('translates every status InPost lists, and nothing InPost does not list', () => {
    expect(live).toHaveLength(53)
    expect(new Set(live).size).toBe(53)
    expect(Object.keys(INPOST_STATUSES).sort()).toEqual([...live].sort())
  })

  it('translates only into Shipment statuses', () => {
    for (const translated of Object.values(INPOST_STATUSES)) {
      if (translated !== null) expect(SHIPMENT_STATUSES).toContain(translated)
    }
  })

  it('never reports `failed` from a status name: only a purchase that cannot happen fails a Shipment', () => {
    expect(namesOf('failed')).toEqual([])
  })

  it('leaves untranslated the statuses that do not say InPost has the parcel: unrecognized, not described, and one that may mean it was never handed over', () => {
    expect(namesOf(null)).toEqual(['missing', 'other', 'oversized'])
  })

  it('groups the names as the connector documents them', () => {
    expect(namesOf('pending')).toEqual(['created', 'offer_selected', 'offers_prepared'])
    expect(namesOf('ready')).toEqual(['confirmed'])
    expect(namesOf('in_transit')).toEqual([
      'adopted_at_sorting_center',
      'adopted_at_source_branch',
      'adopted_at_target_branch',
      'canceled_redirect_to_box',
      'collected_from_sender',
      'delay_in_delivery',
      'dispatched_by_sender',
      'dispatched_by_sender_to_pok',
      'out_for_delivery',
      'out_for_delivery_to_address',
      'readdressed',
      'redirect_to_box',
      'sent_from_sorting_center',
      'sent_from_source_branch',
      'stack_in_box_machine',
      'stack_in_customer_service_point',
      'taken_by_courier',
      'taken_by_courier_from_pok',
      'unstack_from_box_machine',
      'unstack_from_customer_service_point',
    ])
    expect(namesOf('awaiting_pickup')).toEqual([
      'avizo',
      'courier_avizo_in_customer_service_point',
      'pickup_reminder_sent',
      'ready_to_pickup',
      'ready_to_pickup_from_branch',
      'ready_to_pickup_from_pok',
      'ready_to_pickup_from_pok_registered',
    ])
    expect(namesOf('delivery_problem')).toEqual([
      'claimed',
      'pickup_reminder_sent_address',
      'pickup_time_expired',
      'rejected_by_receiver',
      'stack_parcel_in_box_machine_pickup_time_expired',
      'stack_parcel_pickup_time_expired',
      'taken_by_courier_from_customer_service_point',
      'undelivered',
      'undelivered_cod_cash_receiver',
      'undelivered_incomplete_address',
      'undelivered_lack_of_access_letterbox',
      'undelivered_no_mailbox',
      'undelivered_not_live_address',
      'undelivered_unknown_receiver',
      'undelivered_wrong_address',
    ])
    expect(namesOf('delivered')).toEqual(['delivered', 'return_pickup_confirmation_to_sender'])
    // Final, so only the status that says the parcel set off back; "will soon be on its way back" is not that.
    expect(namesOf('returned')).toEqual(['returned_to_sender'])
    expect(namesOf('cancelled')).toEqual(['canceled'])
  })

  it('says the Carrier has the parcel only for a status whose text says so', () => {
    const texts = new Map(liveSchema.parse(JSON.parse(liveText)).items.map((entry) => [entry.name, entry]))
    // No title, no description: "translation missing". Nothing says InPost ever held this parcel.
    expect(texts.get('missing')?.title).toMatch(/translation missing/)
    expect(INPOST_STATUSES.missing).toBeNull()
    // "Does not fit into the locker": says nothing of who holds the parcel, and may mean the sender could not put it in.
    expect(texts.get('oversized')?.description).toMatch(/does not fit into the locker/)
    expect(INPOST_STATUSES.oversized).toBeNull()
    expect(texts.get('taken_by_courier_from_customer_service_point')?.description).toMatch(/will soon be on its way back/)
    expect(texts.get('pickup_reminder_sent_address')?.description).toMatch(/did not find the Recipient/)
  })

  it('keeps the statuses the capabilities name in the table', () => {
    for (const name of PURCHASE_STATUSES) expect(live).toContain(name)
    expect(PURCHASE_STATUSES.map((name) => INPOST_STATUSES[name])).toEqual(['pending', 'pending', 'pending'])
  })
})
