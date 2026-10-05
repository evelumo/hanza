import type { MessageKeys, NestedKeyOf } from 'next-intl'
import type en from '../../messages/en.json'

/** English is the source of truth: every other catalogue must have the same shape. */
export type Messages = typeof en

/** A dotted path to a message, e.g. `products.title`; a key missing from `en.json` is a compile error. */
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>

export type TranslationValues = Record<string, string | number | Date>

/** What helpers outside components receive: the root translator, so they can be tested without React. */
export type Translator = (key: MessageKey, values?: TranslationValues) => string
