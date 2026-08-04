-- Where a technique ENDS UP, closing the graph's remaining half.
--
-- `position` says where a technique starts and `function` says what it does.
-- Neither says where it leaves you, so the library can answer "what can I do
-- from here" (the position screen) and "what follows this" (the inverted
-- setup_from edge) but not "where does this put me" — which is the question a
-- gameplan, a curriculum, or any next-position suggestion is made of.
--
-- WHY THIS IS SPARSE ON PURPOSE, AND WILL STAY SPARSE
--
-- It was measured twice before being built, both times badly:
--
--   1. Name parsing ("X to Y", back takes, guard pulls) reaches 42% — and 97
--      of those are submissions, whose destination is the end of the exchange
--      rather than a position.
--   2. Inverting `setup_from` looked promising and was not: of 159 techniques
--      with followers, 137 have followers in the SAME position. That edge
--      links control-to-attack WITHIN a position, not transitions between
--      them. It infers a real position change for 22 techniques out of 466.
--
-- So this is authoring work, not derivation work, and inventing the rest
-- would produce plausible-looking data that is wrong — worse than absent,
-- because a rule engine cannot tell the difference. The column is populated
-- for the transitions where the destination is both knowable and useful
-- (passes, sweeps, back takes, takedowns) and left NULL everywhere else.
--
-- NULL therefore means "not recorded", NOT "goes nowhere". A technique that
-- genuinely leaves you where you started records its own position, so that
-- "stays put" is a fact rather than an absence. A test pins the populated
-- count so coverage can only rise.
--
-- No CHECK on the vocabulary, per migration 000021 — validated in Go, where
-- adding a position is a code change rather than a migration. And no index:
-- migration 000018 dropped one from this table for being unused, and no
-- query filters on this yet. Add one when a caller exists.
SET lock_timeout = '3s';

ALTER TABLE techniques
    ADD COLUMN to_position TEXT;
