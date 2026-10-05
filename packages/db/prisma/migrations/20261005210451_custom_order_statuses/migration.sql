-- Organization-defined Order statuses (issue #1, ADR 0014). The fixed list becomes the Order phases: renamed in
-- place, never dropped, so every existing Order keeps its value. Each organization gets a default status per phase and
-- every existing Order is moved to the default status of its phase.
--
-- Rollout: this holds an ACCESS EXCLUSIVE lock on "order" for its whole run (rename, full-table UPDATE, NOT NULL,
-- index, foreign key), and code from before it fails against the new schema (and the reverse): stop web and worker,
-- migrate, then start the new version.

-- The old enum type must give up its name before the "order_status" table (and its row type) can be created.
ALTER TYPE "order_status" RENAME TO "order_phase";
ALTER TABLE "order" RENAME COLUMN "status" TO "phase";
ALTER INDEX "order_organizationId_status_idx" RENAME TO "order_organizationId_phase_idx";

-- CreateEnum
CREATE TYPE "order_status_color" AS ENUM ('gray', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'violet');

-- CreateTable
CREATE TABLE "order_status" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phase" "order_phase" NOT NULL,
    "name" TEXT,
    "color" "order_status_color",
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "replacedById" TEXT,
    "deletionDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_status_pkey" PRIMARY KEY ("id"),
    -- A default status can always be given to an Order, so it cannot be inactive.
    CONSTRAINT "order_status_default_is_active_check" CHECK (NOT "isDefault" OR "active"),
    CONSTRAINT "order_status_name_check" CHECK ("name" IS NULL OR btrim("name") <> ''),
    -- Being deleted: inactive, not a default, with a replacement other than itself and a due time for the sweep.
    CONSTRAINT "order_status_deletion_check" CHECK (
      ("replacedById" IS NULL) = ("deletionDueAt" IS NULL)
      AND ("replacedById" IS NULL OR (NOT "active" AND NOT "isDefault" AND "replacedById" <> "id"))
    )
);

-- CreateTable
CREATE TABLE "channel_status_mapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "phase" "order_phase" NOT NULL,
    "statusId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_status_mapping_pkey" PRIMARY KEY ("id"),
    -- The phases a Channel reports: an import (new) and its facts (shipped, cancelled).
    CONSTRAINT "channel_status_mapping_phase_check" CHECK ("phase" IN ('new', 'shipped', 'cancelled'))
);

-- CreateIndex
CREATE UNIQUE INDEX "order_status_organizationId_phase_id_key" ON "order_status"("organizationId", "phase", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_status_one_default_per_phase" ON "order_status"("organizationId", "phase") WHERE ("isDefault");

-- No two active statuses share a name, whatever its case. An expression index: Prisma cannot express it (and leaves it
-- alone), and like a partial one it does not make "name" a key column.
CREATE UNIQUE INDEX "order_status_active_name_key" ON "order_status"("organizationId", lower("name")) WHERE ("active" AND "name" IS NOT NULL);

-- The sweep in sync.tick finds statuses being deleted.
CREATE INDEX "order_status_deletionDueAt_idx" ON "order_status"("deletionDueAt") WHERE ("deletionDueAt" IS NOT NULL);

-- CreateIndex
CREATE INDEX "channel_status_mapping_organizationId_statusId_idx" ON "channel_status_mapping"("organizationId", "statusId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_status_mapping_connectionId_phase_key" ON "channel_status_mapping"("connectionId", "phase");

-- AddForeignKey
ALTER TABLE "order_status" ADD CONSTRAINT "order_status_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status" ADD CONSTRAINT "order_status_organizationId_phase_replacedById_fkey" FOREIGN KEY ("organizationId", "phase", "replacedById") REFERENCES "order_status"("organizationId", "phase", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "channel_status_mapping" ADD CONSTRAINT "channel_status_mapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_status_mapping" ADD CONSTRAINT "channel_status_mapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_status_mapping" ADD CONSTRAINT "channel_status_mapping_organizationId_phase_statusId_fkey" FOREIGN KEY ("organizationId", "phase", "statusId") REFERENCES "order_status"("organizationId", "phase", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Data: the default statuses of every existing organization (organizations created later get theirs on first use).
-- A null name is shown as the phase's translated name until a person renames the status.
INSERT INTO "order_status" ("id", "organizationId", "phase", "isDefault", "updatedAt")
SELECT gen_random_uuid()::text, o."id", p."phase", true, CURRENT_TIMESTAMP
FROM "organization" o
CROSS JOIN unnest(enum_range(NULL::"order_phase")) AS p("phase");

-- Data: every existing Order gets the default status of its phase.
ALTER TABLE "order" ADD COLUMN "statusId" TEXT;
UPDATE "order" o
SET "statusId" = s."id"
FROM "order_status" s
WHERE s."organizationId" = o."organizationId" AND s."phase" = o."phase" AND s."isDefault";
ALTER TABLE "order" ALTER COLUMN "statusId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "order_organizationId_statusId_idx" ON "order"("organizationId", "statusId");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_organizationId_phase_statusId_fkey" FOREIGN KEY ("organizationId", "phase", "statusId") REFERENCES "order_status"("organizationId", "phase", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
