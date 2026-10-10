-- AlterTable
ALTER TABLE "shipment" ADD COLUMN     "createOutcomeUnknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "labelFailureCode" TEXT;

-- A Shipment still waiting for its Carrier's answer after the Carrier was asked: every one of those calls ended
-- without an answer being stored, so a Shipment may exist at the Carrier.
UPDATE "shipment" SET "createOutcomeUnknown" = true
WHERE "status" = 'requested' AND "externalId" IS NULL AND "createAttempts" > 0;
