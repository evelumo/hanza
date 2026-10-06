import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toPath } from './cassette'
import {
  EMAIL_PATTERN,
  FORBIDDEN_HEADERS,
  isBasicCredential,
  isPlaceholder,
  isReservedEmailDomain,
  JWT_PATTERN,
  normalizeName,
  PHONE_PATTERN,
  SCRUBBED,
  SECRET_NAMES,
  SECRET_PARAM_NAMES,
} from './scrub'

export type SecretRule = 'credential-header' | 'bearer' | 'basic' | 'jwt' | 'secret-value' | 'token-like' | 'email' | 'phone' | 'pesel'

export interface SecretFinding {
  file: string | null
  /** JSON path of the value, e.g. `interactions.3.response.body.json.buyer.email`. */
  path: string
  rule: SecretRule
  /** The start of the value only; a finding never prints a whole secret. */
  excerpt: string
}

export interface LintOptions {
  /** Known false positives: a string equal to, or a regex matching, the flagged text. */
  allow?: Array<string | RegExp>
}

const BEARER = /\bBearer\s+(?!\[scrubbed\])[A-Za-z0-9\-._~+/]{8,}=*/gi
const BASIC = /\bBasic\s+(?!\[scrubbed\])([A-Za-z0-9+/]{8,}={0,2})/g
const SECRET_PARAM = /(?:[?&]|^)([A-Za-z][A-Za-z0-9_.-]*)=([^&#\s"'<>]+)/g
const ELEVEN_DIGITS = /(?<!\d)\d{11}(?!\d)/g
const PHONE_ONCE = new RegExp(PHONE_PATTERN.source)

/** A Polish PESEL: a valid date of birth (month carries the century) and a valid checksum. */
export function looksLikePesel(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false
  const d = [...digits].map(Number)
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]
  const sum = weights.reduce((total, weight, index) => total + weight * d[index]!, 0)
  if ((10 - (sum % 10)) % 10 !== d[10]) return false
  const month = d[2]! * 10 + d[3]!
  const day = d[4]! * 10 + d[5]!
  const monthOfYear = month % 20
  return monthOfYear >= 1 && monthOfYear <= 12 && day >= 1 && day <= 31
}

function excerpt(value: string): string {
  return value.length <= 6 ? '*'.repeat(value.length) : `${value.slice(0, 4)}… (${value.length} chars)`
}

// `offerId`, `order_id`, `ids`, `ID`; not `paid` or `valid`.
const isIdKey = (key: string | undefined) =>
  key !== undefined && (/^ids?$/i.test(key) || /[a-z0-9](Ids?|ID)$/.test(key) || /[-_]ids?$/i.test(key))
/**
 * `csrfToken`, `webhookSecret`: names the scrubber cannot blanket-replace (`nextPageToken` is a cursor fixtures
 * need), so the lint flags a long token-shaped value under them and the connector declares or allows it.
 */
function isTokenLike(key: string, value: unknown): boolean {
  const name = normalizeName(key)
  if (!/(token|secret)$/.test(name) || /page|cursor|next|type/.test(name) || typeof value !== 'string') return false
  return value.length >= 20 && /^[A-Za-z0-9._~+/=-]+$/.test(value) && !isPlaceholder(value)
}

const isPhoneKey = (key: string | undefined) => key !== undefined && /phone|mobile|^tel(ephone)?$/.test(normalizeName(key))

/** Everything in a JSON value that looks like a live credential or personal data. */
export function findSecrets(value: unknown, options: LintOptions & { file?: string } = {}): SecretFinding[] {
  const findings: SecretFinding[] = []
  const allowed = (text: string) =>
    (options.allow ?? []).some((rule) => (typeof rule === 'string' ? rule === text : new RegExp(rule.source, rule.flags.replace('g', '')).test(text)))
  const report = (path: string[], rule: SecretRule, text: string) => {
    if (!allowed(text)) findings.push({ file: options.file ?? null, path: path.join('.'), rule, excerpt: excerpt(text) })
  }

  const scanString = (text: string, path: string[], key: string | undefined) => {
    for (const match of text.matchAll(BEARER)) report(path, 'bearer', match[0])
    for (const match of text.matchAll(BASIC)) if (isBasicCredential(match[1]!)) report(path, 'basic', match[0])
    for (const match of text.matchAll(JWT_PATTERN)) report(path, 'jwt', match[0])
    for (const match of text.matchAll(SECRET_PARAM)) {
      const raw = match[2]!
      if (SECRET_PARAM_NAMES.has(normalizeName(match[1]!)) && raw !== SCRUBBED && raw !== encodeURIComponent(SCRUBBED)) {
        report(path, 'secret-value', raw)
      }
    }
    for (const match of text.matchAll(EMAIL_PATTERN)) if (!isReservedEmailDomain(match[1]!)) report(path, 'email', match[0])
    for (const match of text.matchAll(PHONE_PATTERN)) report(path, 'phone', match[0])
    if (isPhoneKey(key) && !isPlaceholder(text) && (text.match(/\d/g)?.length ?? 0) >= 7 && !PHONE_ONCE.test(text)) {
      report(path, 'phone', text)
    }
    if (!isIdKey(key)) for (const match of text.matchAll(ELEVEN_DIGITS)) if (looksLikePesel(match[0])) report(path, 'pesel', match[0])
  }

  // `key` is the nearest object key: array items are judged by the key that holds the array.
  const walk = (node: unknown, path: string[], key: string | undefined) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, String(index)], key))
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = [...path, childKey]
        if (key === 'headers' && FORBIDDEN_HEADERS.has(childKey.toLowerCase())) {
          report(childPath, 'credential-header', typeof child === 'string' ? child : childKey)
        } else if (SECRET_NAMES.has(normalizeName(childKey)) && typeof child === 'string' && child !== '' && child !== SCRUBBED) {
          report(childPath, 'secret-value', child)
        } else if (isTokenLike(childKey, child)) {
          report(childPath, 'token-like', child as string)
        }
        walk(child, childPath, childKey)
      }
      return
    }
    if (typeof node === 'string') scanString(node, path, key)
    else if (typeof node === 'number' && Number.isInteger(node) && !isIdKey(key) && looksLikePesel(String(node))) report(path, 'pesel', String(node))
  }

  walk(value, [], undefined)
  return findings
}

async function jsonFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path]
  const entries = await readdir(path, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** Lints one JSON file, or every `.json` file under a directory. */
export async function lintFixtures(target: string | URL, options: LintOptions = {}): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = []
  for (const file of await jsonFiles(toPath(target))) {
    let json: unknown
    try {
      json = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      throw new Error(`${file} is not valid JSON`)
    }
    findings.push(...findSecrets(json, { ...options, file }))
  }
  return findings
}

export function formatFindings(findings: SecretFinding[]): string {
  return findings.map(({ file, path, rule, excerpt }) => `  ${file ?? '(value)'}: ${path || '(root)'} [${rule}] ${excerpt}`).join('\n')
}

/**
 * Fails when fixtures contain anything that looks like a live token, secret, e-mail, phone number or PESEL.
 * Takes a file, a directory (every `.json` below it) or an in-memory value such as a cassette.
 */
export async function assertNoSecrets(target: string | URL | object, options: LintOptions & { file?: string } = {}): Promise<void> {
  const findings = typeof target === 'string' || target instanceof URL ? await lintFixtures(target, options) : findSecrets(target, options)
  if (findings.length > 0) {
    throw new Error(
      `Fixtures contain ${findings.length} value(s) that look like secrets or personal data:\n${formatFindings(findings)}\n` +
        'Scrub them (ScrubConfig) and record again, or list a known false positive in `allow`.',
    )
  }
}
