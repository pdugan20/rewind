-- Originally intended to add ON DELETE CASCADE to FK constraints
-- D1 runs migrations in a single transaction with foreign_keys=ON
-- Table recreation (drop + rename) is not possible when FK relationships exist
-- CASCADE behavior is handled at the application layer in Drizzle instead
SELECT 1;
