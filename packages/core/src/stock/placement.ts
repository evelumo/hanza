/**
 * The placement rule (ADR 0013): the first Warehouse, in the Channel's order, whose Available covers
 * the whole line; when none does, the first one and the line is a Shortage. A line is never split.
 * `candidates` are the Channel's Warehouses in placement order with their Available of the Product;
 * when there are none, `fallbackWarehouseId` (the default Warehouse) is used, as a Shortage.
 */
export function chooseWarehouse(
  candidates: Array<{ warehouseId: string; available: number }>,
  units: number,
  fallbackWarehouseId: string,
): { warehouseId: string; shortage: boolean } {
  const covering = candidates.find((candidate) => candidate.available >= units)
  if (covering) return { warehouseId: covering.warehouseId, shortage: false }
  return { warehouseId: candidates[0]?.warehouseId ?? fallbackWarehouseId, shortage: true }
}
