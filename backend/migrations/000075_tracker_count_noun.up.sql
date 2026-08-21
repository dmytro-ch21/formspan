-- The word for one tap, said by the athlete instead of guessed from the unit.
--
-- ## What was wrong
--
-- N76 derived the noun on the client: `ml` and `cup` meant "cup", `g`, `mg` and
-- `dose` meant "dose", everything else meant nothing. It recorded the failure in
-- the same comment that implemented it — an athlete tracking 30 g of fibre in
-- 5 g steps reads **"6 doses"**, which is not a sentence anybody says.
--
-- ## Why a bigger table does not fix it
--
-- The obvious repair is more rows in the mapping, and it cannot work, because
-- the noun is a property of the SUBSTANCE and the unit does not carry it:
--
--     5 g of creatine   -> a dose
--     5 g of fibre      -> a serving
--     30 g of protein   -> a scoop
--
-- All three are `g`. No function of `{ml, g, mg, cup, dose, count}` separates
-- them, because the distinguishing fact was never in the input. The only party
-- that knows is the athlete, so this column is where they say it, and the old
-- table survives on the client as what it always really was: a SUGGESTION
-- prefilled into the create form, which the athlete can overwrite.
--
-- Empty is a real value and the default: "4 of 8" with no noun at all is the
-- right reading for a tracker that counts cold showers.

SET lock_timeout = '3s';

ALTER TABLE daily_trackers
    ADD COLUMN count_noun TEXT NOT NULL DEFAULT ''
        -- Length only. The client's own validator additionally refuses control
        -- characters and surrounding whitespace; both are enforced in Go rather
        -- than here because the message a rejected athlete reads should name the
        -- rule, and a CHECK violation cannot.
        CHECK (length(count_noun) <= 24);

-- Backfill EXACTLY the mapping the client was applying, so no existing card's
-- copy moves on deploy. Water provisions with 'cup' from `presets.go` for new
-- athletes; this is for the rows already out there, which were written before
-- the column existed and would otherwise silently lose their noun.
--
-- `''` for 'count' and for the empty unit is not a gap: those already rendered
-- with no noun, and this preserves that.
UPDATE daily_trackers
   SET count_noun = CASE unit
       WHEN 'ml'   THEN 'cup'
       WHEN 'cup'  THEN 'cup'
       WHEN 'g'    THEN 'dose'
       WHEN 'mg'   THEN 'dose'
       WHEN 'dose' THEN 'dose'
       ELSE ''
   END
 WHERE count_noun = '';

COMMENT ON COLUMN daily_trackers.count_noun IS
    'The singular word for one tap — "cup", "capsule", "scoop" — or empty for a '
    'tracker that just counts. Authored, never derived: the noun belongs to the '
    'substance and the unit cannot tell 5 g of creatine from 5 g of fibre.';
