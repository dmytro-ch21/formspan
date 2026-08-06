-- Steps first: `bjj_sequence_steps.sequence_id` references the parent, and
-- while the FK's ON DELETE CASCADE handles row deletion it does not let the
-- parent TABLE be dropped out from under it.
DROP TABLE IF EXISTS bjj_sequence_steps;
DROP TABLE IF EXISTS bjj_sequences;
