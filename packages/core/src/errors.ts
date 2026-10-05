import { Prisma } from '@hanza/db'

export type DomainErrorCode =
  | 'not_found'
  | 'sku_taken'
  | 'invalid_transition'
  | 'unmatched_lines'
  | 'already_linked'
  | 'unknown_connector'
  | 'invalid_config'

/** Thrown by services for expected failures; the panel maps `code` to translated copy. */
export class DomainError extends Error {
  override readonly name = 'DomainError'

  constructor(
    readonly code: DomainErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code)
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
