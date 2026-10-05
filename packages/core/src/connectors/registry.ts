import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { DomainError } from '../errors'

/** The connectors this process knows; the apps pass them in, so the core never imports a connector. */
export interface ConnectorRegistry {
  list(): AnyConnectorDefinition[]
  get(id: string): AnyConnectorDefinition | undefined
  /** Throws `DomainError('unknown_connector')`. */
  require(id: string): AnyConnectorDefinition
}

export function createConnectorRegistry(definitions: AnyConnectorDefinition[]): ConnectorRegistry {
  const byId = new Map<string, AnyConnectorDefinition>()
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Connector "${definition.id}" is registered twice`)
    byId.set(definition.id, definition)
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    require(id) {
      const definition = byId.get(id)
      if (!definition) throw new DomainError('unknown_connector', `Unknown connector "${id}"`)
      return definition
    },
  }
}
