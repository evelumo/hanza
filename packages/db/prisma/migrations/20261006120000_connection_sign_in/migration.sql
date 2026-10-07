-- CreateEnum
CREATE TYPE "sign_in_status" AS ENUM ('starting', 'pending', 'approved', 'denied', 'expired', 'failed', 'account_mismatch', 'account_in_use', 'cancelled');

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "accountLabel" TEXT,
ADD COLUMN     "credentialsExpireAt" TIMESTAMP(3),
ADD COLUMN     "credentialsVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "connection_sign_in" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "connectionId" TEXT,
    "name" TEXT,
    "config" JSONB,
    "status" "sign_in_status" NOT NULL DEFAULT 'starting',
    "userCode" TEXT,
    "verificationUri" TEXT,
    "verificationUriComplete" TEXT,
    "deviceCode" TEXT,
    "intervalSeconds" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "accountLabel" TEXT,
    "accountId" TEXT,
    "approvedCredentials" TEXT,
    "createdByUserId" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_sign_in_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_sign_in_organizationId_createdAt_idx" ON "connection_sign_in"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "connection_sign_in_connectionId_idx" ON "connection_sign_in"("connectionId");

-- CreateIndex
CREATE INDEX "connection_sign_in_status_expiresAt_idx" ON "connection_sign_in"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "connection_organizationId_connectorId_accountId_key" ON "connection"("organizationId", "connectorId", "accountId");

-- AddForeignKey
ALTER TABLE "connection_sign_in" ADD CONSTRAINT "connection_sign_in_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_sign_in" ADD CONSTRAINT "connection_sign_in_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
