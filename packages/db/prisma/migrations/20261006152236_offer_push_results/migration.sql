-- CreateEnum
CREATE TYPE "offer_channel_status" AS ENUM ('active', 'inactive', 'ended');

-- CreateEnum
CREATE TYPE "offer_ended_reason" AS ENUM ('sold_out', 'other');

-- AlterTable
ALTER TABLE "offer" ADD COLUMN     "channelEndedReason" "offer_ended_reason",
ADD COLUMN     "channelStatus" "offer_channel_status",
ADD COLUMN     "priceRejectedAt" TIMESTAMP(3),
ADD COLUMN     "priceRejectedCode" TEXT,
ADD COLUMN     "stockRejectedAt" TIMESTAMP(3),
ADD COLUMN     "stockRejectedCode" TEXT;

-- An ended reason only with an ended status; a rejection code and its time are set together.
ALTER TABLE "offer" ADD CONSTRAINT "offer_channel_ended_reason_check"
  CHECK ("channelEndedReason" IS NULL OR "channelStatus" = 'ended');
ALTER TABLE "offer" ADD CONSTRAINT "offer_stock_rejected_check"
  CHECK (("stockRejectedCode" IS NULL) = ("stockRejectedAt" IS NULL));
ALTER TABLE "offer" ADD CONSTRAINT "offer_price_rejected_check"
  CHECK (("priceRejectedCode" IS NULL) = ("priceRejectedAt" IS NULL));
