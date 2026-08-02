-- Let a position narrow its cross-link within its own family.
--
-- WHY: `family` prefix-matches `techniques.position`, which records only
-- "Guard - Bottom"/"Guard - Top". So Closed Guard and Open Guard — two
-- positions a beginner must learn to tell apart — resolved to the identical
-- 187 techniques, and the Open Guard screen listed closed-guard entries
-- directly beneath its own sentence saying the ankles are not locked.
--
-- That shipped once with a prose disclaimer instead of a fix, and the
-- disclaimer was itself wrong: it told the reader the library could not tell
-- closed from open. It can. `techniques.position_detail` carries "Closed Guard"
-- on 35 rows and "Open Guard" on 37. The distinction was always in the data;
-- nothing could express it.
--
-- WHY TWO COLUMNS RATHER THAN ONE: the two positions need opposite operations.
-- Closed guard is a small enumerable set ("Closed Guard", "Rubber Guard"), so
-- it lists what it wants. Open guard is "the rest of the family" across 26
-- detail values that grow as the library does, so listing them would be a
-- maintenance trap that silently drops new ones — it names the handful it
-- excludes instead. Include is a whitelist, exclude a blacklist, and each is
-- the cheap direction for one of the two.
--
-- Empty on all eight other positions, which take their whole family.
ALTER TABLE positions
    ADD COLUMN detail_includes TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN detail_excludes TEXT[] NOT NULL DEFAULT '{}';
