import { Prisma } from '@hanza/db'

export type DomainErrorCode =
  | 'not_found'
  | 'sku_taken'
  | 'invalid_transition'
  | 'awaiting_payment'
  | 'unmatched_lines'
  | 'already_linked'
  | 'unknown_connector'
  | 'connector_not_configured'
  | 'sign_in_required'
  | 'no_sign_in'
  | 'invalid_config'
  | 'combination_taken'
  | 'invalid_attributes'
  | 'already_in_family'
  | 'invalid_price'
  | 'not_a_channel'
  | 'warehouse_inactive'
  | 'warehouse_is_default'
  | 'warehouse_not_empty'
  | 'warehouse_in_use'
  | 'no_warehouse_selected'
  | 'reservation_not_open'
  | 'not_enough_stock'
  | 'forbidden'
  | 'status_is_default'
  | 'status_in_use'
  | 'invalid_replacement'
  | 'status_name_taken'
  | 'status_inactive'
  | 'status_name_required'
  | 'status_pending_deletion'
  | 'status_is_replacement'
  | 'not_linked'

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
