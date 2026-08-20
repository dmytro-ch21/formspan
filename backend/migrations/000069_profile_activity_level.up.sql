-- The athlete's daily-movement level, which until now lived nowhere.
--
-- It was a `useState('light')` on two screens. The pills reset every time the
-- Goals tab lost focus, and the derived calorie target reset with them — so the
-- number an athlete read and the number they came back to were different, with
-- nothing saying so. Reported from a real device as "Target doesn't save
-- previously added type of activity" (N93).
--
-- NULLABLE, and that is the substantive choice here rather than an oversight.
-- NULL means "this athlete has never said", which is a different fact from
-- "this athlete chose sedentary". A NOT NULL DEFAULT 'light' would have made
-- the two indistinguishable, and the screen would then show a filled pill
-- attributing a choice to somebody who never made one. The derivation still
-- uses `light` when this is NULL — that is the documented default, applied at
-- read time where it can be labelled as an assumption.
--
-- NO CHECK CONSTRAINT, per the convention migration 000021 established and
-- 000040 restates: an enumerated vocabulary is validated in Go, where changing
-- it is a code change rather than a migration. `profile.ValidActivityLevel` is
-- the guard, and `nutrition.Activities` is the list it mirrors — both pinned to
-- string literals by tests, so neither can drift silently.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS activity_level TEXT;

COMMENT ON COLUMN profiles.activity_level IS
    'Daily movement outside logged training: sedentary | light | active. NULL means never chosen — the derivation assumes light and says so.';
