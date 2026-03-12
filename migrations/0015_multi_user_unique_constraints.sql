-- Originally intended to change unique constraints to include user_id
-- D1 runs migrations in a single transaction with foreign_keys=ON
-- Table recreation (drop + rename) is not possible when FK relationships exist
-- These constraints can be added later when multi-user support is actually needed
SELECT 1;
