-- CreateEnum
CREATE TYPE "offer_link_method" AS ENUM ('sku', 'manual');

-- CreateEnum
CREATE TYPE "connection_health" AS ENUM ('unknown', 'ok', 'failing', 'auth_expired');

-- CreateEnum
CREATE TYPE "sync_stream" AS ENUM ('offers_pull', 'orders_pull', 'stock_push', 'order_status_push');

-- CreateEnum
CREATE TYPE "sync_error_kind" AS ENUM ('auth_expired', 'rate_limited', 'transient', 'permanent');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('new', 'processing', 'shipped', 'cancelled');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('prepaid', 'cash_on_delivery');

-- CreateEnum
CREATE TYPE "attention_reason" AS ENUM ('unmatched_line', 'shortage', 'cancelled_while_processing', 'channel_fact_conflict');

-- CreateEnum
CREATE TYPE "channel_fact_type" AS ENUM ('cancelled', 'shipped');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('open', 'released', 'consumed');

-- AlterTable
ALTER TABLE "event_log" ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "subjectType" TEXT;

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "productId" TEXT,
    "linkedBy" "offer_link_method",
    "stockPushSeq" INTEGER NOT NULL DEFAULT 0,
    "stockPushedSeq" INTEGER NOT NULL DEFAULT 0,
    "lastPushedAvailable" INTEGER,
    "lastPushedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credentials" TEXT NOT NULL,
    "health" "connection_health" NOT NULL DEFAULT 'unknown',
    "healthChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "stream" "sync_stream" NOT NULL,
    "cursor" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "lastErrorKind" "sync_error_kind",
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'new',
    "attentionReasons" "attention_reason"[] DEFAULT ARRAY[]::"attention_reason"[],
    "placedAt" TIMESTAMP(3) NOT NULL,
    "payment" "payment_method" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "totalAmount" DECIMAL(19,4) NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "buyerPhone" TEXT,
    "buyerLogin" TEXT,
    "shippingAddress" JSONB NOT NULL,
    "billingAddress" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "offerExternalId" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceAmount" DECIMAL(19,4) NOT NULL,
    "productId" TEXT,
    "shortage" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_channel_fact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" "channel_fact_type" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_channel_fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_organizationId_name_idx" ON "product"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_organizationId_sku_key" ON "product"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "offer_organizationId_productId_idx" ON "offer"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "offer_organizationId_sku_idx" ON "offer"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "offer_connectionId_productId_idx" ON "offer"("connectionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_connectionId_externalId_key" ON "offer"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "connection_organizationId_connectorId_idx" ON "connection"("organizationId", "connectorId");

-- CreateIndex
CREATE INDEX "sync_state_organizationId_idx" ON "sync_state"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_connectionId_stream_key" ON "sync_state"("connectionId", "stream");

-- CreateIndex
CREATE INDEX "order_organizationId_placedAt_idx" ON "order"("organizationId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "order_organizationId_status_idx" ON "order"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_connectionId_externalId_key" ON "order"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "order_line_organizationId_productId_idx" ON "order_line"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_orderId_externalId_key" ON "order_line"("orderId", "externalId");

-- CreateIndex
CREATE INDEX "order_channel_fact_organizationId_recordedAt_idx" ON "order_channel_fact"("organizationId", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "order_channel_fact_orderId_externalId_key" ON "order_channel_fact"("orderId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_organizationId_code_key" ON "warehouse"("organizationId", "code");

-- CreateIndex
CREATE INDEX "stock_organizationId_idx" ON "stock"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_productId_warehouseId_key" ON "stock"("productId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_orderLineId_key" ON "reservation"("orderLineId");

-- CreateIndex
CREATE INDEX "reservation_organizationId_productId_status_idx" ON "reservation"("organizationId", "productId", "status");

-- CreateIndex
CREATE INDEX "reservation_productId_warehouseId_status_idx" ON "reservation"("productId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "event_log_organizationId_subjectType_subjectId_createdAt_idx" ON "event_log"("organizationId", "subjectType", "subjectId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_channel_fact" ADD CONSTRAINT "order_channel_fact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_channel_fact" ADD CONSTRAINT "order_channel_fact_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
