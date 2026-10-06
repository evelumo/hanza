// Preloaded into the worker by the e2e runner (`node --import`), never part of a normal start.
// The fake Channel keeps what it was told in the worker's memory; this serves it to the flows.
// It imports the same `@hanza/connector-fake` module instance as the worker's registry (one realpath).
import { createServer } from 'node:http'
import { fakeChannel } from '@hanza/connector-fake'

const port = Number(process.env.HANZA_E2E_PROBE_PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error('HANZA_E2E_PROBE_PORT is not set')

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/fake-channel') {
    const body = JSON.stringify({ stockPushes: fakeChannel.stockPushes, statusUpdates: fakeChannel.statusUpdates })
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    return
  }
  response.writeHead(404).end()
}).listen(port, '127.0.0.1')
