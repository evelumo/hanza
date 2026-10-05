import { describe, expect, it } from 'vitest'
import { channelAvailable, channelWarehousesAvailable } from './channel-available'
import { chooseWarehouse } from './placement'

const w = (warehouseId: string, available: number) => ({ warehouseId, available })

describe('chooseWarehouse', () => {
  it('takes the first Warehouse in order whose Available covers the whole line', () => {
    expect(chooseWarehouse([w('a', 5), w('b', 9)], 5, 'default')).toEqual({ warehouseId: 'a', shortage: false })
    expect(chooseWarehouse([w('a', 4), w('b', 9)], 5, 'default')).toEqual({ warehouseId: 'b', shortage: false })
    expect(chooseWarehouse([w('a', -2), w('b', 0), w('c', 1)], 1, 'default')).toEqual({ warehouseId: 'c', shortage: false })
  })

  it('never splits a line: when no single Warehouse covers it, it is a Shortage in the Warehouse with the most Available', () => {
    // 3 + 3 would cover 5, but only across two Warehouses; a tie goes to the first in order.
    expect(chooseWarehouse([w('a', 3), w('b', 3)], 5, 'default')).toEqual({ warehouseId: 'a', shortage: true })
    expect(chooseWarehouse([w('a', 1), w('b', 4)], 5, 'default')).toEqual({ warehouseId: 'b', shortage: true })
    expect(chooseWarehouse([w('a', -3), w('b', -1)], 1, 'default')).toEqual({ warehouseId: 'b', shortage: true })
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

describe('channelWarehousesAvailable', () => {
  it('is the smaller of the sum and the largest single Warehouse', () => {
    expect(channelWarehousesAvailable([3, 2])).toBe(3)
    expect(channelWarehousesAvailable([4, 6])).toBe(6)
    // An oversold Warehouse owes units: they come off the sum.
    expect(channelWarehousesAvailable([-2, 2])).toBe(0)
    expect(channelWarehousesAvailable([-2, 2, 5])).toBe(5)
    expect(channelWarehousesAvailable([-4, 2, 1])).toBe(-1)
    // Stock spread thin is under-advertised until lines can be split (#70).
    expect(channelWarehousesAvailable(Array.from({ length: 10 }, () => 1))).toBe(1)
  })

  it('with one Warehouse is its Available, and with none is 0', () => {
    for (const available of [-5, 0, 7]) expect(channelWarehousesAvailable([available])).toBe(available)
    expect(channelWarehousesAvailable([])).toBe(0)
  })

  it('an empty Warehouse joining or leaving never changes what a Channel is told', () => {
    for (const layout of [[], [3], [-2], [-2, 2], [0, -1], [5, 1, -3]]) {
      const rules = { safetyBuffer: 1, channelLimit: null }
      expect(channelAvailable(channelWarehousesAvailable([...layout, 0]), rules)).toBe(channelAvailable(channelWarehousesAvailable(layout), rules))
    }
  })

  // A seeded generator, so a failure can be reproduced.
  function random(seed: number) {
    let state = seed
    return (min: number, max: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return min + (state % (max - min + 1))
    }
  }

  it('property: told ≥ 0, ≤ the largest single Warehouse and ≤ the sum, and any line it allows fits in one Warehouse', () => {
    const next = random(4)
    for (let run = 0; run < 2_000; run++) {
      const available = Array.from({ length: next(1, 6) }, () => next(-5, 12))
      const rules = { safetyBuffer: next(0, 3), channelLimit: next(0, 3) === 0 ? next(0, 8) : null }
      const told = channelAvailable(channelWarehousesAvailable(available), rules)
      const sum = available.reduce((total, value) => total + value, 0)
      expect(told).toBeGreaterThanOrEqual(0)
      expect(told).toBeLessThanOrEqual(Math.max(0, Math.max(...available)))
      expect(told).toBeLessThanOrEqual(Math.max(0, sum))
      // Whatever line the Channel may sell from this number is covered by one Warehouse: never a Shortage.
      const candidates = available.map((value, index) => w(`w${index}`, value))
      for (let units = 1; units <= told; units++) expect(chooseWarehouse(candidates, units, 'default').shortage).toBe(false)
    }
  })
})
