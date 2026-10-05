import { describe, expect, it } from 'vitest'
import { chooseWarehouse } from './placement'

const w = (warehouseId: string, available: number) => ({ warehouseId, available })

describe('chooseWarehouse', () => {
  it('takes the first Warehouse in order whose Available covers the whole line', () => {
    expect(chooseWarehouse([w('a', 5), w('b', 9)], 5, 'default')).toEqual({ warehouseId: 'a', shortage: false })
    expect(chooseWarehouse([w('a', 4), w('b', 9)], 5, 'default')).toEqual({ warehouseId: 'b', shortage: false })
    expect(chooseWarehouse([w('a', -2), w('b', 0), w('c', 1)], 1, 'default')).toEqual({ warehouseId: 'c', shortage: false })
  })

  it('never splits a line: when no single Warehouse covers it, the first one takes it as a Shortage', () => {
    // 3 + 3 would cover 5, but only across two Warehouses.
    expect(chooseWarehouse([w('a', 3), w('b', 3)], 5, 'default')).toEqual({ warehouseId: 'a', shortage: true })
    expect(chooseWarehouse([w('a', -1)], 1, 'default')).toEqual({ warehouseId: 'a', shortage: true })
  })

  it('with one Warehouse is the old rule: a Shortage exactly when Available < quantity', () => {
    for (const available of [-3, 0, 1, 2, 3, 10]) {
      expect(chooseWarehouse([w('only', available)], 3, 'default')).toEqual({ warehouseId: 'only', shortage: available < 3 })
    }
  })

  it('without candidates falls back to the given Warehouse as a Shortage', () => {
    expect(chooseWarehouse([], 1, 'default')).toEqual({ warehouseId: 'default', shortage: true })
  })
})
