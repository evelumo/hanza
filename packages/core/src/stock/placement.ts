/**
 * The placement rule (ADR 0013): the first Warehouse, in the Channel's order, whose Available covers
 * the whole line. When none does, the line is a Shortage and goes to the Warehouse with the largest
 * Available (the first such one in order), so the units it is owed are as few as they can be. A line
 * is never split. `candidates` are the Channel's Warehouses in placement order with their Available
 * of the Product; when there are none, `fallbackWarehouseId` (the default Warehouse) takes the line
 * as a Shortage.
 */
export function chooseWarehouse(
  candidates: Array<{ warehouseId: string; available: number }>,
  units: number,
  fallbackWarehouseId: string,
): { warehouseId: string; shortage: boolean } {
  const covering = candidates.find((candidate) => candidate.available >= units)
  if (covering) return { warehouseId: covering.warehouseId, shortage: false }
  let best: { warehouseId: string; available: number } | undefined
  for (const candidate of candidates) if (!best || candidate.available > best.available) best = candidate
  return { warehouseId: best?.warehouseId ?? fallbackWarehouseId, shortage: true }
}
