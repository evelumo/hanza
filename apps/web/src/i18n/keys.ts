import en from '../../messages/en.json'
import type { MessageKey } from './types'

/** Identity at runtime; at compile time it proves `key` exists, so schemas can carry keys instead of text. */
export const messageKey = (key: MessageKey): MessageKey => key

/** Whether `value` is the path of a message in the catalogue (zod may hand back its own default text instead). */
export function isMessageKey(value: string): value is MessageKey {
  let node: unknown = en
  for (const part of value.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}
