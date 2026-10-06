-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "allWarehouses" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "warehouse" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "connection_warehouse" (
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_warehouse_pkey" PRIMARY KEY ("connectionId","warehouseId")
);

-- CreateIndex
CREATE INDEX "connection_warehouse_organizationId_warehouseId_idx" ON "connection_warehouse"("organizationId", "warehouseId");

-- AddForeignKey
ALTER TABLE "connection_warehouse" ADD CONSTRAINT "connection_warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_warehouse" ADD CONSTRAINT "connection_warehouse_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_warehouse" ADD CONSTRAINT "connection_warehouse_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints; added by hand (ADR 0017): the placement order is a
-- whole number in the panel's range, and the default Warehouse can never be deactivated.
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_priority_check" CHECK ("priority" BETWEEN 0 AND 1000000);
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_default_active_check" CHECK ("code" <> 'default' OR "active");
