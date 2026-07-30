-- Display units are a *presentation* preference, so this column changes
-- nothing about how training data is stored: weights stay kilograms and
-- distances stay metres everywhere in the database. Storing converted
-- values would make every historical row ambiguous the moment someone
-- changed the setting, and would silently corrupt the progression rule,
-- which compares weights across sessions.
ALTER TABLE profiles
  ADD COLUMN unit_system TEXT NOT NULL DEFAULT 'metric';

ALTER TABLE profiles
  ADD CONSTRAINT profiles_unit_system_valid
  CHECK (unit_system IN ('metric', 'imperial'));
