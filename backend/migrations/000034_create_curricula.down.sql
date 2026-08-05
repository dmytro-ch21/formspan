-- Reverse dependency order: enrollments and items both reference curricula.
-- The indexes go with their tables.
DROP TABLE IF EXISTS curriculum_enrollments;
DROP TABLE IF EXISTS curriculum_items;
DROP TABLE IF EXISTS curricula;
