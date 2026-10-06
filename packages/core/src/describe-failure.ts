const MAX_ISSUES = 5

/** Paths and codes only: a Zod message or the input it quotes can hold Buyer data. */
function describeZodIssues(issues: unknown[]): string {
  const parts = issues.slice(0, MAX_ISSUES).map((issue) => {
    const { path, code } = (issue ?? {}) as { path?: unknown; code?: unknown }
    const where = Array.isArray(path) && path.length > 0 ? path.map(String).join('.') : '(root)'
    return `${where} ${typeof code === 'string' ? code : 'invalid'}`
  })
  const more = issues.length > MAX_ISSUES ? ` (and ${issues.length - MAX_ISSUES} more)` : ''
  return `${parts.join('; ')}${more}`
}

/**
 * Error name, Prisma code and the last line of the message: enough to tell what failed. A full
 * Prisma message can quote the query's arguments, which may hold Buyer data. A ZodError is
 * described by its issue paths and codes instead.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected failure'
  const issues = (error as { issues?: unknown }).issues
  if (error.name === 'ZodError' && Array.isArray(issues)) return `ZodError: ${describeZodIssues(issues)}`
  const code = (error as { code?: unknown }).code
  const lines = error.message.split('\n').map((line) => line.trim()).filter(Boolean)
  const detail = (lines.at(-1) ?? '').slice(0, 300)
  return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`
}
