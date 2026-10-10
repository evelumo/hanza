import { getShipmentLabel } from '@hanza/core'
import { getContext } from '@/lib/context'
import { labelFileName } from '@/lib/label-file'
import { requireTenant } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Downloads the Label of one Shipment of this Order. A Label is Buyer data (it prints a name and an address), so
 * it is never cached, and an id of another organization or another Order gets the same empty 404 as a Shipment
 * whose Label is not there: nothing tells them apart.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string; shipmentId: string }> }) {
  const { organizationId } = await requireTenant()
  const { orderId, shipmentId } = await params
  const ctx = getContext()
  const shipment = await ctx.db.shipment.findFirst({
    where: { id: shipmentId, organizationId, orderId },
    select: { id: true, trackingNumber: true },
  })
  const label = shipment ? await getShipmentLabel(ctx, organizationId, shipment.id) : null
  if (!shipment || !label) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })

  // A copy in a buffer of its own: what a `Response` takes as a body.
  return new Response(new Uint8Array(label.data), {
    headers: {
      // From the core's allow-list, and not to be guessed otherwise: a Label is a file from outside.
      'Content-Type': label.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${labelFileName(shipment, label.extension)}"`,
      'Content-Length': String(label.data.byteLength),
      'Cache-Control': 'no-store',
    },
  })
}
