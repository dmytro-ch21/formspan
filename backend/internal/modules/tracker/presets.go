package tracker

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// The seeded presets.
//
// **This file is the answer to "what does the second tracker have to write?"**
// N77 (coffee) is a struct literal below and a colour key in the mobile palette.
// N78 (creatine, and anything the athlete names) writes no preset at all — it
// posts a `New` with `Preset: ""` through the same create endpoint, which is why
// there is nothing here that a custom tracker could not also express.
//
// A preset is a set of DEFAULTS, never a privileged built-in. Once provisioned
// the row is an ordinary tracker: every field is editable, it archives like any
// other, and N78's acceptance criterion — "a reviewer can create a tracker that
// is indistinguishable from water" — holds by construction, because water IS
// one of those rows.
type Preset struct {
	// Key is the stable provisioning key stored in daily_trackers.preset.
	Key string
	// Default provisions this preset for every athlete on first list. Water is
	// on because the whole point of N76 is not forgetting; coffee, when it
	// lands, is a thing the athlete adds, not one we assume they drink.
	Default bool
	// Fields is everything else, and it is the ordinary create payload.
	Fields New
}

// Water.
//
// 250 ml a glass, eight glasses, 2 litres — the familiar target, expressed in
// the canonical unit so the display can be fl oz or ml without the stored
// numbers moving. `unit: "ml"` and `increment: 250` are what make "0 of 8 cups"
// and "0 fl oz" two readings of one number rather than two stored values that
// can disagree.
var presets = []Preset{
	{
		Key:     "water",
		Default: true,
		Fields: New{
			Preset:      "water",
			Name:        "Water",
			Icon:        "💧",
			ColorKey:    "water",
			Unit:        "ml",
			Increment:   250,
			Target:      ptr(2000.0),
			RenderStyle: RenderGlyphs,
			SortOrder:   10,
		},
	},
	// N77 adds coffee here — Key "coffee", Default false, Target nil (a count
	// with no ceiling), ColorKey "coffee", Unit "cup", Increment 1. The colour
	// is already in the mobile palette and already measured by
	// `scripts/validate_palette.mjs` against the water blue, so that PR does not
	// have to discover its hue is unusable. If it needs anything in this package
	// beyond a literal here, the model did not generalise.
}

func ptr[T any](v T) *T { return &v }

// Presets returns every known preset.
func Presets() []Preset { return presets }

// DefaultsFor returns the presets an athlete starts with, as create payloads
// carrying deterministic ids.
//
// **The id is derived from (userID, preset key), and that is load-bearing.** The
// alternative — a random UUID minted at provisioning time — is fine until two
// devices, or two concurrent requests, provision at once: the unique index stops
// the second row, but each device then believes a different id is "the water
// tracker", and the entries one of them logged reference a tracker id the server
// never stored. A derived id makes provisioning genuinely idempotent rather than
// merely non-duplicating.
//
// SHA-256 truncated to 128 bits, hex, with a `t_` prefix so an id is
// recognisable in a log. Not a secret and not a capability: every read in this
// module is scoped by user_id, so knowing another athlete's tracker id buys
// nothing. It is one-way regardless, so a user id cannot be recovered from it.
//
// **It IS computable, though, and that has one consequence worth stating.** A
// Clerk user id is not secret, so anybody can derive another athlete's water
// id. Left unguarded they could create their own tracker on it, and the
// victim's provisioning would then collide on the PRIMARY KEY — which the
// (user_id, preset) arbiter does not cover — turning every subsequent
// GET /v1/trackers into a 409 with no way to ever free the id. Two guards close
// it, deliberately independent of one another: `New.Validate` refuses the `t_`
// namespace on create, and `EnsureDefaults` tolerates a taken id rather than
// failing the whole list. Found by review, not by the suite; both are tested
// now.
func DefaultsFor(userID string) []New {
	out := make([]New, 0, len(presets))
	for _, p := range presets {
		if !p.Default {
			continue
		}
		n := p.Fields
		n.ID = PresetID(userID, p.Key)
		out = append(out, n)
	}
	return out
}

// PresetIDPrefix is the namespace provisioning owns.
//
// A client may not create a tracker whose id starts here — `New.Validate`
// refuses it — because these ids are DERIVED from the athlete's user id and are
// therefore computable by anyone who knows it. See the note on DefaultsFor.
const PresetIDPrefix = "t_"

// PresetID is the deterministic id of one athlete's instance of a preset.
func PresetID(userID, presetKey string) string {
	sum := sha256.Sum256([]byte(userID + "\x00" + presetKey))
	return PresetIDPrefix + hex.EncodeToString(sum[:16])
}

// Validate checks every preset ships legal. Called by a test rather than at
// startup: a malformed preset is a coding error, and failing the build is more
// useful than failing a deploy.
func validatePresets() error {
	seen := map[string]bool{}
	for _, p := range presets {
		if p.Key == "" {
			return fmt.Errorf("tracker: a preset has no key")
		}
		if seen[p.Key] {
			return fmt.Errorf("tracker: duplicate preset key %q", p.Key)
		}
		seen[p.Key] = true
		if p.Fields.Preset != p.Key {
			return fmt.Errorf("tracker: preset %q carries Preset=%q — provisioning would "+
				"key on one and store the other", p.Key, p.Fields.Preset)
		}
		n := p.Fields
		n.ID = PresetID("validate", p.Key)
		// validateFields, not Validate: a preset id legitimately carries the
		// reserved prefix, which is exactly what Validate refuses.
		if err := n.validateFields(); err != nil {
			return fmt.Errorf("tracker: preset %q: %w", p.Key, err)
		}
	}
	return nil
}
