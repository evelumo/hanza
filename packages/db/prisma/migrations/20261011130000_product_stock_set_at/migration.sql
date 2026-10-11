-- Unset Stock (#137, ADR 0023): null until someone saves the Product's Stock; its Offers get no stock push meanwhile.
ALTER TABLE "product" ADD COLUMN     "stockSetAt" TIMESTAMP(3);

-- Every existing Product was created with an explicit Stock (by hand, or from an Offer with Stock 0), so it keeps
-- being pushed as before.
UPDATE "product" SET "stockSetAt" = "createdAt";
