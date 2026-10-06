import { PermanentError, type AnyConnectorDefinition, type AuthContext } from '@hanza/connector-sdk'
import { notConfiguredMessage } from '../connectors/registry'
import type { Context } from '../context'

const FETCH_TIMEOUT_MS = 30_000

/** Global fetch with the core's 30 s timeout, unless the caller passes its own signal. */
export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

/**
 * The connector's installation settings (`ctx.app`). Throws `PermanentError` naming the missing variables
 * (never values) when they are incomplete, so call it where a connector failure is recorded.
 */
export function connectorApp(ctx: Context, connector: AnyConnectorDefinition): unknown {
  const settings = ctx.connectors.settings(connector.id)
  if (!settings.ok) throw new PermanentError(notConfiguredMessage(connector, settings.variables))
  return settings.value
}

/** What the sign-in hooks (`auth.refresh`, `auth.deviceFlow`) get. Log lines carry ids only. */
export function buildAuthContext(
  ctx: Context,
  connector: AnyConnectorDefinition,
  input: { app: unknown; config: unknown; connectionId?: string; signInId?: string },
): AuthContext {
  const fields = {
    connectorId: connector.id,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.signInId ? { signInId: input.signInId } : {}),
  }
  return {
    app: input.app,
    config: input.config,
    fetch: timedFetch,
    log: (message, extra) => ctx.log.info(message, { ...extra, ...fields }),
  }
}
