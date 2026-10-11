-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('requested', 'pending', 'ready', 'in_transit', 'awaiting_pickup', 'delivery_problem', 'delivered', 'returned', 'cancelled', 'failed');

-- AlterEnum
ALTER TYPE "attention_reason" ADD VALUE 'shipment_conflict';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "sync_stream" ADD VALUE 'shipments_create';
ALTER TYPE "sync_stream" ADD VALUE 'shipments_track';

-- CreateTable
CREATE TABLE "shipment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" "shipment_status" NOT NULL DEFAULT 'requested',
    "service" TEXT NOT NULL,
    "parcel" JSONB NOT NULL,
    "codAmount" DECIMAL(19,4),
    "codCurrency" CHAR(3),
    "destination" TEXT,
    "externalId" TEXT,
    "trackingNumber" TEXT,
    "carrierStatus" TEXT,
    "failureCode" TEXT,
    "label" TEXT,
    "labelContentType" TEXT,
    "nextCheckAt" TIMESTAMP(3),
    "handedOverAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "createAttempts" INTEGER NOT NULL DEFAULT 0,
    "createLeaseUntil" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_organizationId_orderId_idx" ON "shipment"("organizationId", "orderId");

-- CreateIndex
CREATE INDEX "shipment_connectionId_nextCheckAt_idx" ON "shipment"("connectionId", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_connectionId_externalId_key" ON "shipment"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Cash on delivery is an amount with its currency; a Label is a file with its content type (the panel reads
-- "has a Label" from the content type alone, never selecting the sealed file).
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cod_check"
  CHECK (("codAmount" IS NULL) = ("codCurrency" IS NULL));
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_label_check"
  CHECK (("label" IS NULL) = ("labelContentType" IS NULL));
