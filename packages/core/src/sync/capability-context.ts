import { PermanentError, type AnyConnectorDefinition, type CapabilityContext } from '@hanza/connector-sdk'
import type { z } from 'zod'
import type { OpenedConnection } from '../connections/connections'
import type { Context } from '../context'
import { connectorApp, timedFetch } from './auth-context'

function issuePaths(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => [prefix, ...issue.path.map(String)].join('.'))
}

/**
 * What a capability gets. Throws `PermanentError` when the connector is not set up on this installation, or the
 * stored config or credentials no longer match the connector's schemas, so call it inside `runConnectorCall` (the
 * run fails, health → failing).
 */
export function buildCapabilityContext(ctx: Context, opened: OpenedConnection, connector: AnyConnectorDefinition): CapabilityContext {
  const app = connectorApp(ctx, connector)
  const config = connector.configSchema.safeParse(opened.config)
  const credentials = connector.credentialsSchema.safeParse(opened.credentials)
  if (!config.success || !credentials.success) {
    // Paths only: issue messages could echo a credential back.
    const paths = [
      ...(config.success ? [] : issuePaths('config', config.error)),
      ...(credentials.success ? [] : issuePaths('credentials', credentials.error)),
    ]
    throw new PermanentError(`The Connection's settings do not match connector "${connector.id}": ${paths.join(', ')}`)
  }
  const fields = { connectionId: opened.id, connectorId: connector.id }
  return {
    app,
    config: config.data,
    credentials: credentials.data,
    fetch: timedFetch,
    log: (message, extra) => ctx.log.info(message, { ...extra, ...fields }),
  }
}
