// Makes a secret API key in the sandbox through the Admin API, signed in as the sandbox's admin, and writes it with the
// sandbox's address to the git-ignored keys file. Usage: node tools/key.mjs <origin> <keys file> <admin e-mail> <password>
// (sandbox.sh key passes them). The key never goes on a command line or to standard output.
import { writeFileSync } from 'node:fs'

const [origin, file, email, password] = process.argv.slice(2)
if (!origin || !file || !email || !password) {
  console.error('Usage: node tools/key.mjs <origin> <keys file> <admin e-mail> <password>')
  process.exit(1)
}

async function post(path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  return response.json()
}

const { token } = await post('/auth/user/emailpass', { email, password })
const { api_key: apiKey } = await post('/admin/api-keys', { title: `Hanza recording ${new Date().toISOString()}`, type: 'secret' }, { authorization: `Bearer ${token}` })
if (typeof apiKey?.token !== 'string' || !apiKey.token.startsWith('sk_')) throw new Error('Medusa answered without a secret key')
writeFileSync(file, `${JSON.stringify({ sandboxUrl: origin, apiKey: apiKey.token }, null, 2)}\n`, { mode: 0o600 })
console.log(`Secret API key written to ${file} (ignored by git).`)
