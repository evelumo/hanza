// Preloaded into the worker by the e2e runner (`node --import`), never part of a normal start.
// The fake Channels and the fake Carrier keep what they were told in the worker's memory; this serves it to the
// flows, and lets a flow act as the person on the fake OAuth Channel's sign-in page (approve a code, revoke the
// application).
// It imports the same `@hanza/connector-fake` module instance as the worker's registry (one realpath).
import { createServer, type IncomingMessage } from 'node:http'
import { fakeChannel, fakeCourier, fakeOAuthChannel } from '@hanza/connector-fake'

const port = Number(process.env.HANZA_E2E_PROBE_PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error('HANZA_E2E_PROBE_PORT is not set')

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/fake-channel') {
    const body = JSON.stringify({ stockPushes: fakeChannel.stockPushes, statusUpdates: fakeChannel.statusUpdates })
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    return
  }
  if (request.method === 'GET' && request.url === '/fake-courier') {
    // Ids and statuses only: the requests the fake Carrier keeps hold the receivers, which no flow needs.
    const body = JSON.stringify({
      shipments: fakeCourier.shipments.map(({ account, externalId, reference, status, trackingNumber }) => ({ account, externalId, reference, status, trackingNumber })),
      creates: fakeCourier.creates.map(({ reference, service }) => ({ reference, service })),
      tracks: fakeCourier.tracks,
      labels: fakeCourier.labels,
      cancels: fakeCourier.cancels,
    })
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    return
  }
  if (request.method === 'POST' && (request.url === '/fake-oauth/approve' || request.url === '/fake-oauth/deny')) {
    void jsonBody(request)
      .then(({ userCode, account }) => {
        if (typeof userCode !== 'string') throw new Error('userCode is required')
        if (request.url === '/fake-oauth/deny') fakeOAuthChannel.deny(userCode)
        else fakeOAuthChannel.approve(userCode, account as { id: string; label: string } | undefined)
        response.writeHead(204).end()
      })
      .catch((error: unknown) => response.writeHead(400).end(error instanceof Error ? error.message : String(error)))
    return
  }
  if (request.method === 'POST' && request.url === '/fake-oauth/revoke') {
    fakeOAuthChannel.revokeAll()
    response.writeHead(204).end()
    return
  }
  response.writeHead(404).end()
}).listen(port, '127.0.0.1')
