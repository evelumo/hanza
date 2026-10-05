/**
 * Error name, Prisma code and the last line of the message: enough to tell what failed. A full
 * Prisma message can quote the query's arguments, which may hold Buyer data.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected failure'
  const code = (error as { code?: unknown }).code
  const lines = error.message.split('\n').map((line) => line.trim()).filter(Boolean)
  const detail = (lines.at(-1) ?? '').slice(0, 300)
  return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`
}
