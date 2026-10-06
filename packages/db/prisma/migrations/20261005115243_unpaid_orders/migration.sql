-- AlterEnum
ALTER TYPE "channel_fact_type" ADD VALUE 'paid';

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "awaitingPayment" BOOLEAN NOT NULL DEFAULT false;
