-- IF EXISTS so a partially-applied `up` can still be rolled back, matching
-- 000016/000023/000025.
DROP TABLE IF EXISTS plans;
