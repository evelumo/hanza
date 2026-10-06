import { isAllowedVerificationUri } from '@hanza/connector-sdk'

/** "ABCDEFGHI" → "ABC DEF GHI": easier to read out and type. Other codes (e.g. "WDJB-MJHT") are shown as they are. */
export function formatUserCode(code: string): string {
  const compact = code.replace(/\s+/g, '')
  return /^[A-Za-z0-9]{9}$/.test(compact) ? compact.replace(/^(.{3})(.{3})(.{3})$/, '$1 $2 $3') : code
}

/**
 * The link to show: the page with the code filled in if it is allowed, else the plain page, else none. Only
 * `https:` URLs on a host the connector declares, so a connector cannot send the person anywhere else.
 */
export function signInLink(
  view: { verificationUri: string | null; verificationUriComplete: string | null },
  hosts: readonly string[],
): string | null {
  if (isAllowedVerificationUri(view.verificationUriComplete, hosts)) return view.verificationUriComplete
  if (isAllowedVerificationUri(view.verificationUri, hosts)) return view.verificationUri
  return null
}

/** While a sign-in is open, its page re-reads the status on its own. */
export function isSignInOpen(status: string): boolean {
  return status === 'starting' || status === 'pending'
}
