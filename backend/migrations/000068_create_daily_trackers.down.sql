SET lock_timeout = '3s';

-- Lossy in the way that matters: dropping the definitions takes every logged
-- entry with them through the CASCADE. There is no honest alternative — the
-- entries have no meaning without the tracker whose unit and increment they
-- were recorded against.
DROP TABLE IF EXISTS tracker_entries;
DROP TABLE IF EXISTS daily_trackers;
