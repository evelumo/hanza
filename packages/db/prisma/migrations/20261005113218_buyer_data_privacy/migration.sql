-- AlterTable
ALTER TABLE "order" ADD COLUMN     "buyerData" TEXT,
ADD COLUMN     "buyerDataErasedAt" TIMESTAMP(3),
ADD COLUMN     "buyerDataSealFailedAt" TIMESTAMP(3),
ADD COLUMN     "buyerEmailIndex" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "shippingCountryCode" CHAR(2),
ALTER COLUMN "buyerName" DROP NOT NULL,
ALTER COLUMN "shippingAddress" DROP NOT NULL;

-- CreateTable
CREATE TABLE "privacy_settings" (
    "organizationId" TEXT NOT NULL,
    "buyerDataRetentionDays" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "order_organizationId_buyerEmailIndex_idx" ON "order"("organizationId", "buyerEmailIndex");

-- CreateIndex
CREATE INDEX "order_organizationId_closedAt_idx" ON "order"("organizationId", "closedAt");

-- AddForeignKey
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Orders already final: their exact closing time is not recorded, `updatedAt` is the closest value.
UPDATE "order" SET "closedAt" = "updatedAt" WHERE "status" IN ('shipped', 'cancelled') AND "closedAt" IS NULL;

-- The country is kept after erasure; legacy rows are sealed later by the `privacy.sweep` job (ADR 0011).
UPDATE "order" SET "shippingCountryCode" = "shippingAddress"->>'countryCode' WHERE "shippingCountryCode" IS NULL AND "shippingAddress" IS NOT NULL;
