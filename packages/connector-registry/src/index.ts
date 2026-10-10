import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { fakeConnector, fakeCourierConnector, fakeOAuthConnector } from '@hanza/connector-fake'

/** Every connector this build of Hanza knows. Adding a connector = a dependency + one line here. */
export const connectors: AnyConnectorDefinition[] = [
  fakeConnector,
  // Usable only where HANZA_CONNECTOR_FAKE_OAUTH_* is set (demos, the e2e suite); listed as "not set up" elsewhere.
  fakeOAuthConnector,
  fakeCourierConnector,
]
