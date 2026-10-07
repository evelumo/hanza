import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { DomainError } from '../errors'
import { readConnectorSettings, type ConnectorSettings, type SettingsSource } from './settings'

/** The connectors this process knows; the apps pass them in, so the core never imports a connector. */
export interface ConnectorRegistry {
  list(): AnyConnectorDefinition[]
  get(id: string): AnyConnectorDefinition | undefined
  /** Throws `DomainError('unknown_connector')`. */
  require(id: string): AnyConnectorDefinition
  /**
   * The connector's installation settings, read once from `HANZA_CONNECTOR_<ID>_*`. On failure only the
   * variable names are returned, never values. Throws `DomainError('unknown_connector')`.
   */
  settings(id: string): ConnectorSettings
  /** Throws `DomainError('connector_not_configured')` (with the variable names) unless the settings are complete. */
  requireConfigured(id: string): AnyConnectorDefinition
}

export function createConnectorRegistry(
  definitions: AnyConnectorDefinition[],
  options: { settings?: SettingsSource } = {},
): ConnectorRegistry {
  const byId = new Map<string, AnyConnectorDefinition>()
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Connector "${definition.id}" is registered twice`)
    byId.set(definition.id, definition)
  }
  // Read once: the environment does not change while the process runs (a change needs a restart).
  const settings = new Map([...byId.values()].map((definition) => [definition.id, readConnectorSettings(definition, options.settings ?? {})]))
  const require = (id: string) => {
    const definition = byId.get(id)
    if (!definition) throw new DomainError('unknown_connector', `Unknown connector "${id}"`)
    return definition
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    require,
    settings: (id) => settings.get(require(id).id)!,
    requireConfigured(id) {
      const definition = require(id)
      const result = settings.get(id)!
      if (!result.ok) {
        throw new DomainError('connector_not_configured', notConfiguredMessage(definition, result.variables), { variables: result.variables })
      }
      return definition
    },
  }
}

/** Names the variables, never their values. */
export function notConfiguredMessage(connector: AnyConnectorDefinition, variables: string[]): string {
  return `${connector.name} is not set up on this installation: ${variables.join(', ')}`
}
