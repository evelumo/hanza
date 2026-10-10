import { describe, expect, it } from 'vitest'
import type { Cassette, CassetteInteraction } from './cassette'
import { CassetteMissError, createReplayFetch } from './replay'

const API = 'https://api.example.test'

function entry(
  method: string,
  path: string,
  response: Partial<CassetteInteraction['response']> = {},
  request: Partial<CassetteInteraction['request']> = {},
): CassetteInteraction {
  return {
    request: { method, url: `${API}${path}`, headers: {}, body: null, ...request },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: { json: { path } }, ...response },
  }
}

const cassette = (...interactions: CassetteInteraction[]): Cassette => ({ version: 1, interactions })

async function missOf(promise: Promise<unknown>): Promise<CassetteMissError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CassetteMissError)
  return error as CassetteMissError
}

describe('createReplayFetch', () => {
  it('serves the recorded response, whatever the order of query parameters and volatile headers', async () => {
    const replay = createReplayFetch(cassette(entry('GET', '/offers?page=2&limit=10', { headers: { 'content-type': 'application/json', link: '<x>' } })))
    const response = await replay.fetch(`${API}/offers?limit=10&page=2`, { headers: { authorization: 'Bearer abc', 'x-request-id': '1' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('link')).toBe('<x>')
    expect(await response.json()).toEqual({ path: '/offers?page=2&limit=10' })
  })

  it('ignores the listed query parameters', async () => {
    const replay = createReplayFetch(cassette(entry('GET', '/events?from=1&ts=111')), { match: { ignoreQueryParams: ['ts'] } })
    expect((await replay.fetch(`${API}/events?ts=999&from=1`)).status).toBe(200)
  })

  it('matches JSON bodies by content, not key order, and tells different bodies apart', async () => {
    const replay = createReplayFetch(
      cassette(
        entry('PUT', '/stock', { status: 204, body: null }, { headers: { 'content-type': 'application/json' }, body: { json: { id: 'a', quantity: 1 } } }),
        entry('PUT', '/stock', { status: 202, body: null }, { headers: { 'content-type': 'application/json' }, body: { json: { id: 'a', quantity: 2 } } }),
      ),
    )
    const put = (body: string) => replay.fetch(`${API}/stock`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
    expect((await put('{"quantity":2,"id":"a"}')).status).toBe(202)
    expect((await put('{"quantity":1,"id":"a"}')).status).toBe(204)
    const miss = await missOf(put('{"quantity":3,"id":"a"}'))
    expect(miss.message).toContain('differs in body')
  })

  it('can ignore bodies, and can require selected headers to match', async () => {
    const recorded = entry('POST', '/search', {}, { headers: { accept: 'application/vnd.v2+json' }, body: { json: { q: 'old' } } })
    const loose = createReplayFetch(cassette(recorded), { match: { body: false } })
    expect((await loose.fetch(`${API}/search`, { method: 'POST', body: '{"q":"new"}' })).status).toBe(200)
    const strict = createReplayFetch(cassette(recorded), { match: { body: false, headers: ['Accept'] } })
    const miss = await missOf(strict.fetch(`${API}/search`, { method: 'POST', headers: { accept: 'application/json' } }))
    expect(miss.message).toContain('differs in header "accept"')
    expect(miss.message).not.toContain('application/json')
  })

  it('serves identical requests in recorded order, then repeats the last answer', async () => {
    const replay = createReplayFetch(
      cassette(entry('GET', '/task/1', { body: { json: { state: 'PENDING' } } }), entry('GET', '/task/1', { body: { json: { state: 'DONE' } } })),
    )
    const states = []
    for (let i = 0; i < 3; i++) states.push(((await (await replay.fetch(`${API}/task/1`)).json()) as { state: string }).state)
    expect(states).toEqual(['PENDING', 'DONE', 'DONE'])
  })

  it('fails once the recorded answers are used up when asked to', async () => {
    const replay = createReplayFetch(cassette(entry('GET', '/task/1')), { match: { exhausted: 'error' }, name: 'tasks.cassette.json' })
    await replay.fetch(`${API}/task/1`)
    const miss = await missOf(replay.fetch(`${API}/task/1`))
    expect(miss.message).toBe(`All 1 recorded responses in tasks.cassette.json for GET ${API}/task/1 were already served.`)
  })

  it('with repeat-reads, repeats a GET for ever but serves a write only as often as it was recorded', async () => {
    const body = { headers: { 'content-type': 'application/json' }, body: { json: { reference: 'shp_1' } } }
    const replay = createReplayFetch(
      cassette(
        entry('GET', '/shipments?reference=shp_1', { body: { json: { items: [] } } }),
        entry('POST', '/shipments', { status: 201 }, body),
        entry('DELETE', '/shipments/1', { status: 204, body: null }),
        entry('DELETE', '/shipments/1', { status: 404 }),
      ),
      { match: { exhausted: 'repeat-reads' }, name: 'conformance.cassette.json' },
    )
    const post = () => replay.fetch(`${API}/shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reference":"shp_1"}' })
    for (let i = 0; i < 3; i++) expect((await replay.fetch(`${API}/shipments?reference=shp_1`)).status).toBe(200)
    expect((await post()).status).toBe(201)
    const miss = await missOf(post())
    expect(miss.message).toBe(`All 1 recorded responses in conformance.cassette.json for POST ${API}/shipments were already served.`)
    // Recorded twice, served twice, in order; a third is one the recording never made.
    expect((await replay.fetch(`${API}/shipments/1`, { method: 'DELETE' })).status).toBe(204)
    expect((await replay.fetch(`${API}/shipments/1`, { method: 'DELETE' })).status).toBe(404)
    await missOf(replay.fetch(`${API}/shipments/1`, { method: 'DELETE' }))
    expect(replay.misses).toHaveLength(2)

    // The default still answers a repeated write with the last response, which is what hides a second POST.
    const lenient = createReplayFetch(cassette(entry('POST', '/shipments', { status: 201 }, body)))
    const again = () => lenient.fetch(`${API}/shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reference":"shp_1"}' })
    expect([(await again()).status, (await again()).status]).toEqual([201, 201])
  })

  it('names the nearest recorded requests on a miss, with what differs, never headers or bodies', async () => {
    const replay = createReplayFetch(
      cassette(
        entry('GET', '/orders?cursor=1'),
        entry('GET', '/orders?cursor=1'),
        entry('GET', '/orders?cursor=2'),
        entry('POST', '/orders/1/status'),
        entry('GET', '/offers'),
        entry('DELETE', '/everything/else/entirely'),
      ),
      { name: 'conformance.cassette.json' },
    )
    const miss = await missOf(
      replay.fetch(`${API}/orders?cursor=3`, { headers: { authorization: 'Bearer live-token-123', cookie: 'sid=1' } }),
    )
    expect(miss.message).toBe(
      [
        `No recorded interaction in conformance.cassette.json for GET ${API}/orders?cursor=3.`,
        'Nearest recorded requests:',
        `  1. GET ${API}/orders?cursor=1 (differs in query "cursor")`,
        `  2. GET ${API}/orders?cursor=2 (differs in query "cursor")`,
        `  3. GET ${API}/offers (differs in path; query "cursor")`,
        'If the connector changed its requests on purpose, record the cassette again (HANZA_RECORD_FIXTURES=1).',
      ].join('\n'),
    )
    expect(replay.misses).toEqual([miss.message])
  })

  it('shows the scrubbed URL in a miss, never a secret the request carried', async () => {
    const replay = createReplayFetch(cassette(entry('GET', '/offers')))
    const miss = await missOf(replay.fetch(`${API}/offers?access_token=live-token-123&page=2`))
    expect(miss.message).toContain(`GET ${API}/offers?access_token=%5Bscrubbed%5D&page=2`)
    expect(miss.message).not.toContain('live-token-123')
  })

  it('scrubs the incoming request like the recording, so test credentials stand in for the recorded ones', async () => {
    const recorded = entry(
      'POST',
      '/oauth/token?client_id=%5Bscrubbed%5D',
      { body: { json: { access_token: '[scrubbed]' } } },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { text: 'grant_type=refresh_token&refresh_token=%5Bscrubbed%5D' } },
    )
    const replay = createReplayFetch(cassette(recorded), { secrets: ['test-refresh-token'] })
    const response = await replay.fetch(`${API}/oauth/token?client_id=test-client`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: 'test-refresh-token', grant_type: 'refresh_token' }),
    })
    expect(await response.json()).toEqual({ access_token: '[scrubbed]' })
  })

  it('returns no body for 204, text and binary bodies as recorded, and reports unused interactions', async () => {
    const replay = createReplayFetch(
      cassette(
        entry('PUT', '/a', { status: 204, headers: {}, body: null }),
        entry('GET', '/b', { headers: { 'content-type': 'text/csv' }, body: { text: 'id;qty\n1;2' } }),
        entry('GET', '/c', { headers: { 'content-type': 'application/pdf' }, body: { base64: Buffer.from('%PDF').toString('base64') } }),
        entry('GET', '/never'),
      ),
    )
    const empty = await replay.fetch(`${API}/a`, { method: 'PUT' })
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    expect(await (await replay.fetch(`${API}/b`)).text()).toBe('id;qty\n1;2')
    expect(Buffer.from(await (await replay.fetch(`${API}/c`)).arrayBuffer()).toString()).toBe('%PDF')
    expect(replay.unused()).toEqual([`GET ${API}/never`])
  })

  it('honours an aborted signal, also on a Request passed without init', async () => {
    const replay = createReplayFetch(cassette(entry('GET', '/offers')))
    await expect(replay.fetch(`${API}/offers`, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(replay.fetch(new Request(`${API}/offers`, { signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
