import { z } from 'zod'
import type { SecretBox } from '../secrets'

// What a Shipment keeps of its Buyer: where a person confirmed it goes, and the Label, which prints a name and an
// address. Both are sealed like the Order's Buyer data (ADR 0016) and erased with it (ADR 0023).

/** What a sealed value is bound to: a value copied to another Shipment or tenant does not open. */
export interface ShipmentKey {
  organizationId: string
  shipmentId: string
}

/** Where a person confirmed the parcel goes: the Order's own shipping address, read when the Carrier is asked, or the pickup point they chose. */
export const confirmedDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('address') }),
  z.object({ type: z.literal('pickup_point'), pointId: z.string().min(1) }),
])
export type ConfirmedDestination = z.infer<typeof confirmedDestinationSchema>

function aad(purpose: 'shipment-destination' | 'shipment-label', key: ShipmentKey): string {
  return JSON.stringify([purpose, key.organizationId, key.shipmentId])
}

export function sealDestination(secrets: SecretBox, key: ShipmentKey, destination: ConfirmedDestination): string {
  return secrets.seal(JSON.stringify(confirmedDestinationSchema.parse(destination)), aad('shipment-destination', key))
}

/** Throws when the value does not open or does not parse. */
export function openDestination(secrets: SecretBox, key: ShipmentKey, sealed: string): ConfirmedDestination {
  return confirmedDestinationSchema.parse(JSON.parse(secrets.open(sealed, aad('shipment-destination', key))))
}

export function sealLabel(secrets: SecretBox, key: ShipmentKey, data: Uint8Array): string {
  return secrets.seal(Buffer.from(data).toString('base64'), aad('shipment-label', key))
}

/** Throws when the value does not open. */
export function openLabel(secrets: SecretBox, key: ShipmentKey, sealed: string): Uint8Array {
  return new Uint8Array(Buffer.from(secrets.open(sealed, aad('shipment-label', key)), 'base64'))
}

/** A Label larger than this is not stored: it is one page, and the sealed file sits in a database row. */
export const MAX_LABEL_BYTES = 5 * 1024 * 1024

const UNKNOWN_TYPE = 'application/octet-stream'
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/

/**
 * What is stored of the content type a connector reported: the bare media type in lower case, or
 * `application/octet-stream`. The column is plaintext, so anything that is not a media type never reaches it.
 */
export function storedContentType(reported: string): string {
  const type = reported.split(';')[0]!.trim().toLowerCase()
  return MEDIA_TYPE.test(type) ? type : UNKNOWN_TYPE
}

export interface LabelFileType {
  /** Safe to send as a `Content-Type` header. */
  contentType: string
  /** For the name of the downloaded file. */
  extension: 'pdf' | 'png' | 'zpl' | 'epl' | 'bin'
}

const PRINTER_LANGUAGES = ['zpl', 'epl'] as const

/**
 * The type a stored Label is served with. An allow-list, so a Carrier cannot have the panel serve a file a browser
 * would run (HTML, SVG): a PDF, a PNG, printer commands as plain text, or else a download of unknown type.
 */
export function labelFileType(stored: string): LabelFileType {
  if (stored === 'application/pdf') return { contentType: 'application/pdf', extension: 'pdf' }
  if (stored === 'image/png') return { contentType: 'image/png', extension: 'png' }
  for (const language of PRINTER_LANGUAGES) {
    const names = [`text/${language}`, `text/x-${language}`, `application/${language}`, `application/x-${language}`, `x-application/${language}`]
    if (names.includes(stored)) return { contentType: 'text/plain; charset=utf-8', extension: language }
  }
  return { contentType: UNKNOWN_TYPE, extension: 'bin' }
}
