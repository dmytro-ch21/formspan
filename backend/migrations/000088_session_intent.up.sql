-- N474: what the athlete meant this session to be, decided by them — never
-- inferred from what they actually lifted. See SessionIntent's own doc
-- comment in internal/modules/session/session.go for the full reasoning.
--
-- NOT NULL DEFAULT 'normal' rather than nullable: every session logged
-- before this column existed is a normal session by construction (nothing
-- else it could have meant), and the progression rule already treats an
-- unrecognised/absent intent as "counts as evidence" being the wrong
-- default to fall back to silently — so the column itself must never be
-- absent, only ever one of the three real values.
ALTER TABLE sessions
    ADD COLUMN intent TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE sessions
    ADD CONSTRAINT sessions_intent_valid CHECK (intent IN ('normal', 'light', 'deload'));
