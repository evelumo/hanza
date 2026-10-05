import { describe, expect, it } from 'vitest'
import { catalogues } from './catalogues'
import { isMessageKey } from './keys'

function flatten(node: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') result.set(path, value)
    else if (typeof value === 'object' && value !== null) for (const [k, v] of flatten(value, path)) result.set(k, v)
    else throw new Error(`${path} is neither a string nor a group`)
  }
  return result
}

/**
 * The ICU arguments of a message as `name:type` (`count:plural`, `total:number`, `name:string`) plus, for
 * plurals, the selectors they spell out (`select` and `selectordinal` are parsed but not reported: their
 * selectors are not the CLDR plural categories). A small parser: `{name}`, `{name, type}`, `{name, type, style}`
 * and `{name, plural|select, selector {message} ...}` with nesting.
 */
function icuArguments(message: string): { args: Set<string>; selectors: Map<string, Set<string>> } {
  const args = new Set<string>()
  const selectors = new Map<string, Set<string>>()
  let position = 0

  const skipSpaces = () => {
    while (/\s/.test(message[position] ?? '')) position++
  }
  const readUntil = (stops: string) => {
    const start = position
    while (position < message.length && !stops.includes(message[position] as string)) position++
    return message.slice(start, position).trim()
  }
  // Reads text up to the closing brace of the current message, descending into arguments.
  const readMessage = () => {
    while (position < message.length && message[position] !== '}') {
      if (message[position] === '{') readArgument()
      else position++
    }
  }
  const readArgument = () => {
    position++ // {
    const name = readUntil(',}')
    if (message[position] === '}') {
      args.add(`${name}:string`)
      position++
      return
    }
    position++ // ,
    const type = readUntil(',}')
    args.add(`${name}:${type}`)
    if (message[position] === '}') {
      position++
      return
    }
    position++ // ,
    if (type === 'plural' || type === 'select' || type === 'selectordinal') {
      const found = new Set<string>()
      if (type === 'plural') selectors.set(name, found)
      skipSpaces()
      while (position < message.length && message[position] !== '}') {
        const selector = readUntil('{')
        found.add(selector)
        position++ // {
        readMessage()
        position++ // }
        skipSpaces()
      }
    } else {
      readUntil('}') // a format style such as `short`
    }
    position++ // }
  }

  readMessage()
  return { args, selectors }
}

const en = flatten(catalogues.en)
const pl = flatten(catalogues.pl)

describe('message catalogues', () => {
  it('have exactly the same keys in English and Polish', () => {
    expect([...pl.keys()].sort()).toEqual([...en.keys()].sort())
  })

  it('have no empty messages', () => {
    for (const [locale, messages] of [['en', en], ['pl', pl]] as const) {
      for (const [key, message] of messages) expect(message.trim(), `${locale}: ${key}`).not.toBe('')
    }
  })

  it('use the same ICU placeholders in every language', () => {
    for (const [key, message] of en) {
      expect([...icuArguments(pl.get(key) ?? '').args].sort(), key).toEqual([...icuArguments(message).args].sort())
    }
  })

  it('spell out the plural forms each language needs', () => {
    for (const [key, message] of en) {
      for (const [name, found] of icuArguments(message).selectors) {
        expect(found, `en: ${key} ${name}`).toContain('other')
        expect(found, `en: ${key} ${name}`).toContain('one')
      }
    }
    for (const [key, message] of pl) {
      for (const [name, found] of icuArguments(message).selectors) {
        for (const category of ['one', 'few', 'many', 'other']) expect(found, `pl: ${key} ${name}`).toContain(category)
      }
    }
  })

  it('keep dots out of the keys, which next-intl reads as nesting', () => {
    for (const key of en.keys()) {
      for (const part of key.split('.')) expect(part).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })
})

describe('icuArguments', () => {
  it('finds plain, formatted, plural and nested arguments', () => {
    const { args, selectors } = icuArguments('Hi {name}: {total, number} {count, plural, =0 {none} one {# of {kind}} other {# items}}')
    expect([...args].sort()).toEqual(['count:plural', 'kind:string', 'name:string', 'total:number'])
    expect([...(selectors.get('count') ?? [])]).toEqual(['=0', 'one', 'other'])
  })

  it('reports plural selectors only, not those of select or selectordinal', () => {
    const { args, selectors } = icuArguments('{kind, select, a {x} other {y}} {n, selectordinal, one {#st} other {#th}}')
    expect([...args].sort()).toEqual(['kind:select', 'n:selectordinal'])
    expect(selectors.size).toBe(0)
  })
})

describe('isMessageKey', () => {
  it('accepts the path of a message and nothing else', () => {
    expect(isMessageKey('validation.skuRequired')).toBe(true)
    expect(isMessageKey('validation')).toBe(false)
    expect(isMessageKey('validation.nope')).toBe(false)
    expect(isMessageKey('Invalid input: expected string')).toBe(false)
    expect(isMessageKey('constructor')).toBe(false)
    expect(isMessageKey('')).toBe(false)
  })
})
