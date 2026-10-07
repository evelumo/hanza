import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** A recorded body: parsed JSON, text, or base64 for binary content. */
export const cassetteBodySchema = z.union([
  z.object({ json: z.unknown() }).strict(),
  z.object({ text: z.string() }).strict(),
  z.object({ base64: z.string() }).strict(),
])
export type CassetteBody = z.infer<typeof cassetteBodySchema>

export const cassetteInteractionSchema = z.object({
  request: z.object({
    method: z.string().min(1),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    body: cassetteBodySchema.nullable(),
  }),
  response: z.object({
    status: z.number().int().min(200).max(599),
    headers: z.record(z.string(), z.string()),
    body: cassetteBodySchema.nullable(),
  }),
})
export type CassetteInteraction = z.infer<typeof cassetteInteractionSchema>

export const cassetteSchema = z.object({
  version: z.literal(1),
  interactions: z.array(cassetteInteractionSchema),
})
export type Cassette = z.infer<typeof cassetteSchema>

export const CASSETTE_SUFFIX = '.cassette.json'

export function toPath(file: string | URL): string {
  return file instanceof URL ? fileURLToPath(file) : file
}

export async function loadCassette(file: string | URL): Promise<Cassette> {
  const path = toPath(file)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No cassette at ${path}. Record it with HANZA_RECORD_FIXTURES=1 (see packages/connectors/README.md, "Recorded fixtures").`,
      )
    }
    throw error
  }
  const parsed = cassetteSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`${path} is not a valid cassette:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export async function writeCassette(file: string | URL, cassette: Cassette): Promise<void> {
  const path = toPath(file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(cassetteSchema.parse(cassette), null, 2)}\n`)
}

const TEXT_TYPES = /^text\/|[/+](json|xml|javascript)\b|application\/x-www-form-urlencoded/i
const JSON_TYPES = /[/+]json\b/i

export function isFormContentType(contentType: string | null | undefined): boolean {
  return /application\/x-www-form-urlencoded/i.test(contentType ?? '')
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Null for an empty body; JSON when it says (or looks like) JSON and parses; text when it is textual; else base64. */
export function encodeBody(bytes: Uint8Array, contentType: string | null): CassetteBody | null {
  if (bytes.byteLength === 0) return null
  const textual = contentType === null ? isUtf8(bytes) : TEXT_TYPES.test(contentType)
  if (!textual) return { base64: Buffer.from(bytes).toString('base64') }
  const text = new TextDecoder().decode(bytes)
  if (JSON_TYPES.test(contentType ?? '') || (contentType === null && /^\s*[[{]/.test(text))) {
    try {
      return { json: JSON.parse(text) }
    } catch {
      return { text }
    }
  }
  return { text }
}

export function bodyToBytes(body: CassetteBody | null): Uint8Array | null {
  if (body === null) return null
  if ('json' in body) return new TextEncoder().encode(JSON.stringify(body.json))
  if ('text' in body) return new TextEncoder().encode(body.text)
  return new Uint8Array(Buffer.from(body.base64, 'base64'))
}

/** JSON with keys sorted at every level, so key order never decides a match. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SHA-256 of the canonical body; form bodies compare with their parameters sorted. */
export function bodyHash(body: CassetteBody | null, contentType: string | null): string | null {
  if (body === null) return null
  let canonical: string
  if ('json' in body) canonical = `json:${canonicalJson(body.json)}`
  else if ('text' in body && isFormContentType(contentType)) canonical = `form:${sortedParams(new URLSearchParams(body.text))}`
  else if ('text' in body) canonical = `text:${body.text}`
  else canonical = `base64:${body.base64}`
  return createHash('sha256').update(canonical).digest('hex')
}

export function sortedParams(params: URLSearchParams, ignore: ReadonlySet<string> = new Set()): string {
  return [...params.entries()]
    .filter(([name]) => !ignore.has(name))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value
  })
  return record
}
