// Preloaded (`node --import <this file>`) into a locally running Hanza worker so that the sandbox's TLS front can be
// reached under a real-looking host name (README.md, "A TLS front"). It answers `dns.lookup` for the names listed in
// WOO_SANDBOX_RESOLVE (comma-separated) with 127.0.0.1, in this process only: no /etc/hosts, no sudo, no DNS service.
// Every other name is resolved as before. Plain JavaScript, so it also loads in a process without a TypeScript loader.
//
// Dev tooling for the sandbox: it only ever answers with the loopback address, and does nothing when the variable is
// unset. Never part of a normal start.
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'
import { promisify } from 'node:util'

const LOOPBACK = { address: '127.0.0.1', family: 4 }
const clean = (name) => name.trim().toLowerCase().replace(/\.+$/, '')
const names = new Set((process.env.WOO_SANDBOX_RESOLVE ?? '').split(',').map(clean).filter(Boolean))

if (names.size > 0) {
  const systemLookup = dns.lookup
  const systemPromiseLookup = dns.promises.lookup
  const isSandbox = (hostname) => typeof hostname === 'string' && names.has(clean(hostname))
  const wantsAll = (options) => typeof options === 'object' && options !== null && options.all === true

  // `net` and `tls` (and so `fetch`) read `dns.lookup` when they connect, so replacing it here reaches them.
  function lookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback
    if (!isSandbox(hostname) || typeof done !== 'function') return systemLookup.call(dns, hostname, options, callback)
    process.nextTick(() => (wantsAll(options) ? done(null, [{ ...LOOPBACK }]) : done(null, LOOPBACK.address, LOOPBACK.family)))
    return {}
  }
  const promiseLookup = (hostname, options) =>
    isSandbox(hostname) ? Promise.resolve(wantsAll(options) ? [{ ...LOOPBACK }] : { ...LOOPBACK }) : systemPromiseLookup.call(dns.promises, hostname, options)
  lookup[promisify.custom] = promiseLookup

  dns.lookup = lookup
  dns.promises.lookup = promiseLookup
  // `import { lookup } from 'node:dns'` in code loaded later sees the replacement too.
  syncBuiltinESMExports()
  process.stderr.write(`[woo-sandbox] resolving ${[...names].join(', ')} to ${LOOPBACK.address} in process ${process.pid}\n`)
}
