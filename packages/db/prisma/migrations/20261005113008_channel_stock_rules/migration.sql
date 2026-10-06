-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "channelLimit" INTEGER,
ADD COLUMN     "safetyBuffer" INTEGER NOT NULL DEFAULT 0;

-- Prisma does not model CHECK constraints; added by hand so no write path can store a value
-- that would let a Channel be told more than Available (ADR 0011).
ALTER TABLE "connection" ADD CONSTRAINT "connection_safetyBuffer_check" CHECK ("safetyBuffer" >= 0);
ALTER TABLE "connection" ADD CONSTRAINT "connection_channelLimit_check" CHECK ("channelLimit" IS NULL OR "channelLimit" >= 0);
