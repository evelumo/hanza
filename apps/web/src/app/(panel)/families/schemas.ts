import { z } from 'zod'
import { isReservedAttributeName, MAX_ATTRIBUTE_NAME_LENGTH, MAX_ATTRIBUTE_VALUE_LENGTH, MAX_FAMILY_ATTRIBUTES } from '@hanza/core'
import { messageKey } from '@/i18n/keys'
import type { MessageKey } from '@/i18n/types'
import { idSchema, skuSchema } from '@/lib/schemas'
import { valueField } from './value-field'

const NAME_REQUIRED = messageKey('validation.nameRequired')
const ATTRIBUTES_INVALID = messageKey('validation.attributesInvalid')
const VALUE_REQUIRED = messageKey('validation.attributeValueRequired')

export const familyNameSchema = z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(100, messageKey('validation.familyNameTooLong'))

/** "Size, Colour" becomes `['Size', 'Colour']`: 1 to 5 names, each at most 50 characters, none twice (ignoring case). */
export const attributeNamesSchema = z
  .string({ error: ATTRIBUTES_INVALID })
  .transform((text) => text.split(',').map((name) => name.trim().replace(/\s+/g, ' ')).filter((name) => name !== ''))
  .refine(
    (names) =>
      names.length >= 1 &&
      names.length <= MAX_FAMILY_ATTRIBUTES &&
      names.every((name) => name.length <= MAX_ATTRIBUTE_NAME_LENGTH && !isReservedAttributeName(name)) &&
      new Set(names.map((name) => name.toLowerCase())).size === names.length,
    ATTRIBUTES_INVALID,
  )

export const createFamilySchema = z.object({ name: familyNameSchema, attributes: attributeNamesSchema })
export const renameFamilySchema = z.object({ familyId: idSchema, name: familyNameSchema })
export const familyIdSchema = z.object({ familyId: idSchema })
export const productIdSchema = z.object({ productId: idSchema })
export const addToFamilySchema = z.object({ familyId: idSchema, sku: skuSchema })

const valueSchema = z.string({ error: VALUE_REQUIRED }).trim().min(1, VALUE_REQUIRED).max(MAX_ATTRIBUTE_VALUE_LENGTH, VALUE_REQUIRED)

/** The submitted value of each attribute, by attribute name; or the message key of each field that is wrong. */
export function parseAttributeValues(
  attributes: readonly string[],
  input: Readonly<Record<string, string | undefined>>,
): { ok: true; values: Record<string, string> } | { ok: false; fieldErrors: Record<string, MessageKey> } {
  // Own properties only: an attribute name must never reach the prototype.
  const entries: Array<[string, string]> = []
  const fieldErrors: Record<string, MessageKey> = {}
  attributes.forEach((name, index) => {
    const parsed = valueSchema.safeParse(input[valueField(index)])
    if (parsed.success) entries.push([name, parsed.data])
    else fieldErrors[valueField(index)] = VALUE_REQUIRED
  })
  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, values: Object.fromEntries(entries) }
}
