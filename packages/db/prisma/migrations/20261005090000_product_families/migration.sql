-- AlterTable
ALTER TABLE "product" ADD COLUMN     "attributeKey" TEXT,
ADD COLUMN     "attributeValues" JSONB,
ADD COLUMN     "familyId" TEXT;

-- CreateTable
CREATE TABLE "product_family" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attributes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_family_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_family_organizationId_name_idx" ON "product_family"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_family_id_organizationId_key" ON "product_family"("id", "organizationId");

-- CreateIndex
CREATE INDEX "product_organizationId_familyId_idx" ON "product"("organizationId", "familyId");

-- CreateIndex
CREATE UNIQUE INDEX "product_familyId_attributeKey_key" ON "product"("familyId", "attributeKey");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_familyId_organizationId_fkey" FOREIGN KEY ("familyId", "organizationId") REFERENCES "product_family"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_family" ADD CONSTRAINT "product_family_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Product is in a family exactly when it has its attribute values (not expressible in the Prisma schema).
ALTER TABLE "product" ADD CONSTRAINT "product_family_membership_check"
  CHECK (("familyId" IS NULL) = ("attributeKey" IS NULL) AND ("familyId" IS NULL) = ("attributeValues" IS NULL));
