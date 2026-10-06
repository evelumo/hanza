/** Where the fake connector sends its requests in HTTP mode; nothing listens there, `FakeApi.fetch` answers. */
export const FAKE_API_URL = 'https://api.fake-channel.test'

export interface FakeApiRequest {
  /** `Date.now()` when the request arrived. */
  at: number
  /** The capability, e.g. `stock.push`. */
  operation: string
  /** The Connection's API key: tells the Connections apart. */
  apiKey: string
}

/** The fake Channel's HTTP side, for tests of what the core does around `ctx.fetch` (rate limits, error mapping). */
export interface FakeApi {
  /** Answers requests to `FAKE_API_URL`; route `fetch` to it in tests (`vi.stubGlobal('fetch', channel.api.fetch)`). */
  readonly fetch: typeof fetch
  /** Every request answered, oldest first. */
  readonly requests: FakeApiRequest[]
  /** The most requests in flight at once, per API key. */
  readonly maxInFlight: Map<string, number>
  /** Answer the next `times` requests (default 1) with this status and headers instead of 204. */
  failNext(status: number, options?: { headers?: Record<string, string>; times?: number }): void
  /** How long each answer takes, so that concurrent requests overlap. Default 0. */
  latencyMs: number
  /** Forget recorded requests and scheduled failures. */
  reset(): void
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests', 503: 'Service Unavailable' }

export function createFakeApi(): FakeApi {
  const requests: FakeApiRequest[] = []
  const maxInFlight = new Map<string, number>()
  const inFlight = new Map<string, number>()
  const failures: Array<{ status: number; headers: Record<string, string> }> = []

  const api: FakeApi = {
    requests,
    maxInFlight,
    latencyMs: 0,
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== FAKE_API_URL) throw new TypeError(`fetch failed: the fake Channel does not serve ${url.origin}`)
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      const apiKey = authorization.replace(/^Bearer /, '')
      requests.push({ at: Date.now(), operation: url.pathname.slice(1), apiKey })
      const current = (inFlight.get(apiKey) ?? 0) + 1
      inFlight.set(apiKey, current)
      maxInFlight.set(apiKey, Math.max(maxInFlight.get(apiKey) ?? 0, current))
      try {
        if (api.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, api.latencyMs))
        const failure = failures.shift()
        if (failure) return new Response(null, { status: failure.status, statusText: STATUS_TEXT[failure.status] ?? '', headers: failure.headers })
        return new Response(null, { status: 204 })
      } finally {
        inFlight.set(apiKey, inFlight.get(apiKey)! - 1)
      }
    },
    failNext(status, { headers = {}, times = 1 } = {}) {
      for (let i = 0; i < times; i++) failures.push({ status, headers })
    },
    reset() {
      requests.length = 0
      maxInFlight.clear()
      failures.length = 0
    },
  }
  return api
}
