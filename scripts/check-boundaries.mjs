// Dependency boundaries (spec stage 1, section 6). pnpm's strict node_modules
// turns a missing dependency into a failed import, so checking manifests is enough:
// 1. A connector depends only on the Connector SDK (plus zod): it cannot import the
//    database, the core or another connector.
// 2. The core, the database and the SDK never depend on a connector or the registry,
//    and the database not even on the SDK.
// 3. Only the registry lists connectors in `dependencies`; apps may use one in tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const SDK = '@hanza/connector-sdk'
const REGISTRY = '@hanza/connector-registry'
const CONNECTOR_ALLOWED = new Set([SDK, 'zod'])
const ALL_KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function manifestsIn(dir) {
  const path = join(root, dir)
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(path, entry.name, 'package.json')))
    .map((entry) => ({ dir: join(dir, entry.name), ...JSON.parse(readFileSync(join(path, entry.name, 'package.json'), 'utf8')) }))
}

const connectors = manifestsIn('packages/connectors')
const apps = manifestsIn('apps')
const packages = manifestsIn('packages')
const connectorNames = new Set(connectors.map((manifest) => manifest.name))
// Also catches a dependency on a connector that does not exist in this checkout.
const isConnector = (name) => connectorNames.has(name) || (name.startsWith('@hanza/connector-') && name !== SDK && name !== REGISTRY)

const errors = []
const deps = (manifest, kinds) => kinds.flatMap((kind) => Object.keys(manifest[kind] ?? {}).map((name) => ({ kind, name })))

for (const manifest of connectors) {
  for (const { name } of deps(manifest, ['dependencies'])) {
    if (!CONNECTOR_ALLOWED.has(name)) errors.push(`${manifest.name}: dependency "${name}" is not allowed (connectors use only ${SDK} and zod)`)
  }
}

const inner = { '@hanza/db': [SDK, REGISTRY], '@hanza/core': [REGISTRY], [SDK]: [REGISTRY] }
for (const manifest of packages) {
  const forbidden = inner[manifest.name]
  if (!forbidden) continue
  for (const { kind, name } of deps(manifest, ALL_KINDS)) {
    if (forbidden.includes(name) || isConnector(name)) errors.push(`${manifest.name}: ${kind} "${name}" is not allowed (section 6, rule 2)`)
  }
}

const appDirs = new Set(apps.map((manifest) => manifest.dir))
for (const manifest of [...apps, ...packages, ...connectors]) {
  if (manifest.name === REGISTRY) continue
  // Apps may use a connector in tests; everything else must not list one at all.
  const kinds = appDirs.has(manifest.dir) ? ['dependencies'] : ALL_KINDS
  for (const { kind, name } of deps(manifest, kinds)) {
    if (isConnector(name)) errors.push(`${manifest.name}: ${kind} "${name}" is not allowed (only ${REGISTRY} depends on connectors)`)
  }
}

if (errors.length > 0) {
  console.error([...new Set(errors)].join('\n'))
  process.exit(1)
}
console.log('Dependency boundaries OK')
