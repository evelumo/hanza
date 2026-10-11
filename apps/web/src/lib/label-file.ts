const MAX_NAME_LENGTH = 80

/**
 * The file name a Label is downloaded under: its tracking number, or the Shipment's id while the Carrier gave none.
 * A tracking number is the Carrier's text, so only letters, digits, dots, dashes and underscores of it are kept:
 * nothing that could end the header value it is sent in, or a path.
 */
export function labelFileName(shipment: { id: string; trackingNumber: string | null }, extension: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, MAX_NAME_LENGTH)
  const name = safe(shipment.trackingNumber ?? '') || safe(shipment.id) || 'shipment'
  return `label-${name}.${extension}`
}
