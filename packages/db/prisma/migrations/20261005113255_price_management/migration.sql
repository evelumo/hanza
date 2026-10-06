-- AlterEnum
ALTER TYPE "sync_stream" ADD VALUE 'price_push';

-- AlterTable
ALTER TABLE "offer" ADD COLUMN     "channelPriceAmount" DECIMAL(19,4),
ADD COLUMN     "channelPriceCurrency" CHAR(3),
ADD COLUMN     "lastPricePushedAt" TIMESTAMP(3),
ADD COLUMN     "lastPushedPriceAmount" DECIMAL(19,4),
ADD COLUMN     "lastPushedPriceCurrency" CHAR(3),
ADD COLUMN     "priceOverrideAmount" DECIMAL(19,4),
ADD COLUMN     "priceOverrideCurrency" CHAR(3),
ADD COLUMN     "pricePushSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pricePushedSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "basePriceAmount" DECIMAL(19,4),
ADD COLUMN     "basePriceCurrency" CHAR(3);

-- A price is an amount and a currency together, and a sale price is never zero or negative (ADR 0011).
ALTER TABLE "product" ADD CONSTRAINT "product_base_price_check"
  CHECK (("basePriceAmount" IS NULL) = ("basePriceCurrency" IS NULL) AND ("basePriceAmount" IS NULL OR "basePriceAmount" > 0));
ALTER TABLE "offer" ADD CONSTRAINT "offer_price_override_check"
  CHECK (("priceOverrideAmount" IS NULL) = ("priceOverrideCurrency" IS NULL) AND ("priceOverrideAmount" IS NULL OR "priceOverrideAmount" > 0));
