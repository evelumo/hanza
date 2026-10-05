import { connectors } from '@hanza/connector-registry'
import { createContext, type Context } from '@hanza/core'

// Survives hot reloads in development, so we don't leak connections.
const globalForContext = globalThis as unknown as { hanzaContext?: Context }

/** The panel only enqueues through `ctx.queue`; connector capabilities run in the worker. */
export function getContext(): Context {
  return (globalForContext.hanzaContext ??= createContext('web', { connectors }))
}
