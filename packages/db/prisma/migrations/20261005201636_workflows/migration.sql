-- CreateEnum
CREATE TYPE "workflow_run_status" AS ENUM ('running', 'sleeping', 'waiting', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "key" TEXT,
    "status" "workflow_run_status" NOT NULL,
    "input" JSONB NOT NULL,
    "currentStep" TEXT,
    "completedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "results" JSONB NOT NULL DEFAULT '{}',
    "waitingFor" TEXT,
    "wakeAt" TIMESTAMP(3),
    "sweptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "lastError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_signal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_signal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_run_organizationId_createdAt_idx" ON "workflow_run"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "workflow_run_status_wakeAt_idx" ON "workflow_run"("status", "wakeAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_organizationId_workflow_key_key" ON "workflow_run"("organizationId", "workflow", "key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_organizationId_id_key" ON "workflow_run"("organizationId", "id");

-- CreateIndex
CREATE INDEX "workflow_signal_organizationId_runId_name_idx" ON "workflow_signal"("organizationId", "runId", "name");

-- CreateIndex
CREATE INDEX "workflow_signal_runId_consumedAt_idx" ON "workflow_signal"("runId", "consumedAt");

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_signal" ADD CONSTRAINT "workflow_signal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_signal" ADD CONSTRAINT "workflow_signal_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "workflow_run"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
