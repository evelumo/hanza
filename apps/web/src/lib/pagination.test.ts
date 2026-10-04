import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, clampPage, nextPage, outOfRangeRedirect, pageCount, pageHref, pageWindow, parsePage, previousPage } from './pagination'

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

describe('pages past the end', () => {
  const five = 5
  const threePages = PAGE_SIZE * 2 + 1

  it('clamps to the last page', () => {
    expect(clampPage(999, five)).toBe(1)
    expect(clampPage(999, 0)).toBe(1)
    expect(clampPage(2, threePages)).toBe(2)
    expect(clampPage(4, threePages)).toBe(3)
  })

  it('never links previous past the end', () => {
    expect(previousPage(1, threePages)).toBeNull()
    expect(previousPage(2, threePages)).toBe(1)
    expect(previousPage(998, threePages)).toBe(3)
    expect(previousPage(999, five)).toBe(1)
  })

  it('links next only before the last page', () => {
    expect(nextPage(1, threePages)).toBe(2)
    expect(nextPage(3, threePages)).toBeNull()
    expect(nextPage(999, threePages)).toBeNull()
  })

  it('builds hrefs that keep the other params and drop page 1', () => {
    expect(pageHref('/orders', { status: 'new', attention: undefined }, 1)).toBe('/orders?status=new')
    expect(pageHref('/orders', { status: 'new' }, 3)).toBe('/orders?status=new&page=3')
    expect(pageHref('/products', {}, 1)).toBe('/products')
  })

  it('redirects to the last page only when the page is out of range', () => {
    expect(outOfRangeRedirect(1, 0, '/products')).toBeNull()
    expect(outOfRangeRedirect(3, threePages, '/products')).toBeNull()
    expect(outOfRangeRedirect(999, five, '/products', { q: 'kubek' })).toBe('/products?q=kubek')
    expect(outOfRangeRedirect(999, threePages, '/orders', { status: 'new' })).toBe('/orders?status=new&page=3')
    expect(outOfRangeRedirect(7, 0, '/products/offers')).toBe('/products/offers')
  })
})
