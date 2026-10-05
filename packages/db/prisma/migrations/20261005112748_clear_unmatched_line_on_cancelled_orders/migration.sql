-- Data only. A cancelled Order no longer carries `unmatched_line` (nothing can be fulfilled any more).
-- Orders cancelled before this change still carry it; later writes keep the invariant, so no sweep job is needed.
-- Idempotent: the WHERE clause only matches rows that still carry the reason, so a second run changes nothing.
UPDATE "order"
SET "attentionReasons" = array_remove("attentionReasons", 'unmatched_line'::"attention_reason"),
    "updatedAt" = now()
WHERE "status" = 'cancelled' AND 'unmatched_line'::"attention_reason" = ANY("attentionReasons");
