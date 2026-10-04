import { createContext, type Context } from '@hanza/core'

// Survives hot reloads in development, so we don't leak connections.
const globalForContext = globalThis as unknown as { hanzaContext?: Context }

export function getContext(): Context {
  return (globalForContext.hanzaContext ??= createContext('web'))
}
