-- Push the rows back into the columns before dropping the table, so a
-- rollback keeps whatever the user chose while the rows were authoritative.
-- Without this, down-migrating silently reverts every toggle to its value at
-- the moment 000020 ran.
UPDATE profiles p SET
    strength_enabled  = COALESCE((SELECT enabled FROM profile_modules m WHERE m.user_id = p.user_id AND m.module_key = 'strength'),  p.strength_enabled),
    bjj_enabled       = COALESCE((SELECT enabled FROM profile_modules m WHERE m.user_id = p.user_id AND m.module_key = 'bjj'),       p.bjj_enabled),
    running_enabled   = COALESCE((SELECT enabled FROM profile_modules m WHERE m.user_id = p.user_id AND m.module_key = 'running'),   p.running_enabled),
    nutrition_enabled = COALESCE((SELECT enabled FROM profile_modules m WHERE m.user_id = p.user_id AND m.module_key = 'nutrition'), p.nutrition_enabled);

DROP TABLE IF EXISTS profile_modules;
