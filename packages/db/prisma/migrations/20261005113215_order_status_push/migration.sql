-- AlterEnum
ALTER TYPE "attention_reason" ADD VALUE 'status_push_failed';

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "statusPushDueAt" TIMESTAMP(3),
ADD COLUMN     "statusPushSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "order_connectionId_statusPushDueAt_idx" ON "order"("connectionId", "statusPushDueAt");
