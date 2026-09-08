ALTER TABLE nutrition_foods DROP CONSTRAINT IF EXISTS nutrition_foods_share_provenance_paired;

ALTER TABLE nutrition_foods
    DROP COLUMN IF EXISTS shared_at,
    DROP COLUMN IF EXISTS shared_by_user_id;
