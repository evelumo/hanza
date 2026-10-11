import { allegroConnector } from '@hanza/connector-allegro'
import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { fakeConnector, fakeOAuthConnector } from '@hanza/connector-fake'

/** Every connector this build of Hanza knows. Adding a connector = a dependency + one line here. */
export const connectors: AnyConnectorDefinition[] = [
  // Usable only where HANZA_CONNECTOR_ALLEGRO_* is set (the operator's registered application); listed as "not set up" elsewhere.
  allegroConnector,
  fakeConnector,
  // Usable only where HANZA_CONNECTOR_FAKE_OAUTH_* is set (demos, the e2e suite); listed as "not set up" elsewhere.
  fakeOAuthConnector,
]
