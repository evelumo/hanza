import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, pageCount, pageWindow, parsePage } from './pagination'

describe('pagination helpers', () => {
  it('reads ?page= defensively', () => {
    expect(parsePage('3')).toBe(3)
    expect(parsePage(['2', '9'])).toBe(2)
    for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', '99999999']) expect(parsePage(bad)).toBe(1)
  })

  it('turns a page into skip and take', () => {
    expect(pageWindow(1)).toEqual({ skip: 0, take: PAGE_SIZE })
    expect(pageWindow(3)).toEqual({ skip: 2 * PAGE_SIZE, take: PAGE_SIZE })
  })

  it('counts at least one page', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(PAGE_SIZE)).toBe(1)
    expect(pageCount(PAGE_SIZE + 1)).toBe(2)
  })
})
