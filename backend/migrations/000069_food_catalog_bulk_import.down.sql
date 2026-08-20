-- Reverses 000068.
--
-- **The name constraint is restored FIRST and rows are truncated to fit**,
-- because 72 imported rows are longer than the 120-character limit this puts
-- back. Without the truncation the ADD CONSTRAINT fails and the whole down
-- migration aborts, leaving a database that can be neither rolled forward nor
-- back.
--
-- Truncation loses the distinguishing tail of those names. That is a real loss
-- and it is the honest cost of rolling this back — the alternative is a down
-- migration that cannot run.
SET lock_timeout = '3s';

UPDATE food_catalog
   SET name = btrim(substring(btrim(name) from 1 for 120))
 WHERE length(btrim(name)) > 120;

ALTER TABLE food_catalog DROP CONSTRAINT food_catalog_name_check;
ALTER TABLE food_catalog ADD CONSTRAINT food_catalog_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 120);

ALTER TABLE food_catalog DROP COLUMN rank_tier;
