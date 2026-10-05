import en from '../../messages/en.json'
import pl from '../../messages/pl.json'
import type { Locale } from './config'
import type { Messages } from './types'

// Typed against `en.json`: a key missing from `pl.json` does not compile.
export const catalogues: Record<Locale, Messages> = { en, pl }
