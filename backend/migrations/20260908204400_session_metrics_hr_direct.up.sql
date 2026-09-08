-- N528/#958: how many of a session's heart-rate samples this app recorded
-- itself, live, from a Bluetooth Heart Rate Profile monitor
-- (`biometric_samples.source_platform = 'bluetooth'`) rather than imported
-- from Apple Health / Health Connect — so the report can say which source
-- its numbers came from. Zero for every session computed before this landed
-- and for every session without a monitor; the Health path is unchanged for
-- those. The fill count (Health samples used to bridge gaps in the direct
-- stream) is sample_count - hr_direct_count, derived rather than stored. The
-- monitor's name is deliberately NOT stored here: `source` is a closed
-- vocabulary (`hr_monitor`), and the phone that paired the monitor is what
-- remembers what it is called.
ALTER TABLE session_metrics
    ADD COLUMN hr_direct_count INTEGER NOT NULL DEFAULT 0
        CHECK (hr_direct_count >= 0);
