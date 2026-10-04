import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { fakeConnector } from '@hanza/connector-fake'

/** Every connector this build of Hanza knows. Adding a connector = a dependency + one line here. */
export const connectors: AnyConnectorDefinition[] = [fakeConnector]
