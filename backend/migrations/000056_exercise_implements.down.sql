-- Restores the derived rule's answer, NOT the pre-migration data.
--
-- The up migration corrected two things at once: it added `implements`, and it
-- set `is_unilateral` back to true on the lunge family. Rolling back cannot
-- recover which rows had the flag flipped off, because that information was
-- exactly what the column conflation destroyed. So this puts `is_unilateral`
-- back to false wherever a two-implement per-side row would otherwise start
-- counting single — which is what the old rule needed to compute x2, and is the
-- state the code being rolled back to expects.
--
-- The reps hint goes back to being wrong on those rows. That is the bug this
-- migration exists to fix, so a rollback reinstating it is correct behaviour.
SET lock_timeout = '3s';

UPDATE exercises
   SET is_unilateral = false
 WHERE load_mode = 'per_side' AND implements = 2;

ALTER TABLE exercises DROP CONSTRAINT IF EXISTS exercises_implements_known;
ALTER TABLE exercises DROP COLUMN IF EXISTS implements;
