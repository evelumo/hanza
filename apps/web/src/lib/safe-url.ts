/** The canonical Offer schema accepts any URL scheme; only web links may become `href`s (no `javascript:`, `data:`, ...). */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
