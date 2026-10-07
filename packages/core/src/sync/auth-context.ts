import { PermanentError, type AnyConnectorDefinition, type AuthContext } from '@hanza/connector-sdk'
import { notConfiguredMessage } from '../connectors/registry'
import type { Context } from '../context'
import { limitFetch, ratePlan } from '../rate-limit/limited-fetch'

const FETCH_TIMEOUT_MS = 30_000

/** Global fetch with the core's 30 s timeout, unless the caller passes its own signal. */
export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

/**
 * The fetch every request of a Connection goes through, capabilities and sign-in hooks alike: the timeout, and the
 * connector's declared rate limits (ADR 0019), so a token refresh or a device-flow poll spends the same application
 * and Connection budgets as the calls it serves. `budgetKey` is the Connection id, or for a sign-in that has no
 * Connection yet, a key of its own (the application budget is shared all the same).
 */
export function connectionFetch(ctx: Context, connector: AnyConnectorDefinition, budgetKey: string): typeof fetch {
  const plan = ratePlan(connector, budgetKey)
  return plan ? limitFetch(timedFetch, plan, { limiter: ctx.rateLimiter, log: ctx.log }) : timedFetch
}

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
  const budgetKey = input.connectionId ?? `sign-in:${input.signInId ?? 'unknown'}`
  return {
    app: input.app,
    config: input.config,
    fetch: connectionFetch(ctx, connector, budgetKey),
    log: (message, extra) => ctx.log.info(message, { ...extra, ...fields }),
  }
}
