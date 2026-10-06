import { encodeBody, headersToRecord, writeCassette, type Cassette, type CassetteInteraction } from './cassette'
import { scrubInteractions, type ScrubConfig } from './scrub'
import { findSecrets, formatFindings, type LintOptions } from './secrets-lint'

export interface RecordingOptions extends LintOptions {
  /** The real transport. Default: the global `fetch`. */
  fetch?: typeof fetch
  scrub?: ScrubConfig
  /** Known secret values (credentials, client secret), replaced wherever they appear. */
  secrets?: Iterable<string>
}

export interface RecordingFetch {
  /** Pass this to the connector as `ctx.fetch`; it returns the real, unscrubbed responses. */
  fetch: typeof fetch
  /** How many interactions were recorded so far. */
  readonly size: number
  /** The recording, scrubbed. The raw interactions never leave memory. */
  cassette(): Cassette
  /** Scrubs, lints and writes the cassette. Writes nothing and throws if the lint still finds something. */
  save(file: string | URL): Promise<void>
}

export function createRecordingFetch(options: RecordingOptions = {}): RecordingFetch {
  const transport = options.fetch ?? globalThis.fetch
  const secrets = [...(options.secrets ?? [])]
  const raw: CassetteInteraction[] = []

  const recordingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const requestBytes = new Uint8Array(await request.clone().arrayBuffer())
    const response = await transport(request)
    const responseBytes = new Uint8Array(await response.clone().arrayBuffer())
    const requestHeaders = headersToRecord(request.headers)
    const responseHeaders = headersToRecord(response.headers)
    raw.push({
      request: {
        method: request.method,
        url: request.url,
        headers: requestHeaders,
        body: encodeBody(requestBytes, requestHeaders['content-type'] ?? null),
      },
      response: {
        status: response.status,
        headers: responseHeaders,
        body: encodeBody(responseBytes, responseHeaders['content-type'] ?? null),
      },
    })
    return response
  }

  const cassette = (): Cassette => ({ version: 1, interactions: scrubInteractions(raw, options.scrub, secrets) })

  return {
    fetch: recordingFetch,
    get size() {
      return raw.length
    },
    cassette,
    async save(file) {
      const scrubbed = cassette()
      const findings = findSecrets(scrubbed, { allow: options.allow, file: String(file) })
      if (findings.length > 0) {
        throw new Error(
          `Not writing ${String(file)}: after scrubbing it still contains ${findings.length} value(s) that look like secrets or personal data:\n` +
            `${formatFindings(findings)}\nDeclare them in the connector's ScrubConfig and record again.`,
        )
      }
      await writeCassette(file, scrubbed)
    },
  }
}
