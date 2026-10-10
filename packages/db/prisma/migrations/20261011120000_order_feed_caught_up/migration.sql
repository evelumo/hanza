-- AlterTable
ALTER TABLE "sync_state" ADD COLUMN     "caughtUpAt" TIMESTAMP(3);

-- A Connection whose Orders pull already succeeded has imported its open Orders: its stock push is not held (#125).
UPDATE "sync_state" SET "caughtUpAt" = "lastSucceededAt"
WHERE "stream" = 'orders_pull' AND "lastSucceededAt" IS NOT NULL;
