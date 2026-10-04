// Connectors may only depend on the Connector SDK (plus zod). pnpm's strict
// node_modules then makes it impossible for them to import the database,
// the core or another connector.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['@hanza/connector-sdk', 'zod'])
const root = join(import.meta.dirname, '..', 'packages', 'connectors')
const errors = []

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifestPath = join(root, entry.name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!ALLOWED.has(dep)) errors.push(`${manifest.name}: dependency "${dep}" is not allowed`)
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('Connector boundaries OK')
