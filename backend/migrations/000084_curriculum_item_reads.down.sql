DROP INDEX IF EXISTS curriculum_item_reads_item_idx;
DROP TRIGGER IF EXISTS curriculum_item_reads_concept_only_trg ON curriculum_item_reads;
DROP FUNCTION IF EXISTS curriculum_item_reads_concept_only();
DROP TABLE IF EXISTS curriculum_item_reads;
