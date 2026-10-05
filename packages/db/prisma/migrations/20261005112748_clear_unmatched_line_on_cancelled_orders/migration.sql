-- Data only. A cancelled Order no longer carries `unmatched_line` (nothing can be fulfilled any more).
-- Orders cancelled before this change still carry it; later writes keep the invariant, so no sweep job is needed.
UPDATE "order"
SET "attentionReasons" = array_remove("attentionReasons", 'unmatched_line'::"attention_reason")
WHERE "status" = 'cancelled' AND 'unmatched_line'::"attention_reason" = ANY("attentionReasons");
