# VOLA system design — how the parts become one product

Status: **draft for discussion**, 2026-07-28. This is the thinking pass before building the sport modules — it decides how BJJ, strength, nutrition, and recovery combine into one product rather than four trackers sharing a login. Nothing here is built yet.

It complements, doesn't replace: [history.md](history.md) is the record of what was decided and when; this file is the target design the next several increments aim at.

---

## 1. The failure mode we're designing against

Multi-sport apps usually fail the same way: they ship a strength tracker, a cardio tracker, and a food log, put them behind one login, and call it unified. The user experiences three apps and a nav bar. Nothing one module knows changes what another module says.

The test for whether VOLA has avoided this is concrete: **does logging a BJJ session change what the strength module recommends tomorrow?** If not, we've built a bundle.

So the unifying thing cannot be navigation. It has to be a single piece of state that every module writes to and every module reads from.

## 2. The organizing concept: one daily state, three dials

Everything in the app is either an **input to** or a **view of** one daily state:

| Dial | The question it answers | Fed by |
|---|---|---|
| **Readiness** | Can I go hard today? | sleep, HRV/RHR, recent load, subjective soreness |
| **Load** | How much have I actually done? | every activity — BJJ, lifting, running — in one currency |
| **Fuel** | Am I eating for what I'm doing? | intake vs. today's and this week's load, weight trend |

This is what makes the product cohesive, and it's why the [unified activity envelope](history.md) was the right early call: a BJJ round and a squat session move the *same* Load dial, both depress tomorrow's Readiness, and Readiness is what the recommendation engine reads. The modules aren't parallel silos — they're inputs to one state machine.

Concretely, the cross-sport rule already named as the differentiator ("heavy legs the day before hard sparring") falls out of this for free. It isn't a special case; it's what happens when planned load and readiness are computed over all sports at once.

**Design consequence:** the Today screen shows the state, not a menu of modules. If a screen makes the user pick a sport before showing them anything, it's wrong.

## 3. Module switching: mostly, the user shouldn't

The instinct is to give each sport a tab or a mode toggle. That's the bundle failure again, and it makes the app feel heavier with each sport we add.

**Modules are filters on one timeline, not destinations.** The existing 5-tab IA (Today / Plan / Log / Progress / Profile) already gets this right and should be defended:

- **Today** — the three dials + what's planned + one tap to log. Sport-agnostic.
- **Plan** — one calendar, all sports on it, colour-coded. Conflicts surface *because* they share a calendar.
- **Log** — the only place a sport is explicitly chosen, and only because "what did you do" genuinely needs an answer.
- **Progress** — filterable by sport, defaults to everything.
- **Profile** — where modules are turned on and off. Twice a year, not daily.

So the honest answer to "how does a user switch modules": **at Log time (a choice they'd make anyway) and in Settings (rarely).** Everywhere else the app shows all enabled sports together. Turning a module off hides its UI and stops its recommendations — it never deletes history.

## 4. Effortless logging — the make-or-break

This is where the product lives or dies. Everything above is worthless if logging is a chore, because unlogged training makes every dial wrong.

**Set an explicit budget and design backward from it: a BJJ session logged in ≤3 taps and ≤5 seconds; a strength session in ≤3 taps for a repeat of last time.** A number like this kills bad design decisions early — a 6-field form for a BJJ session cannot survive contact with it.

Six strategies, roughly in order of leverage:

**1. Predict, then confirm.** After ~2 weeks the app knows this user does BJJ Tue/Thu 19:00 and lifts Mon/Wed/Fri mornings. Today should pre-stage the expected session so logging is *confirmation*, not entry: "BJJ, 90 min, 19:00 — did that?" → one tap. This is by far the biggest lever, and it's log-by-exception rather than log-by-entry.

**2. Passive capture first, manual entry only for the gaps.** HealthKit / Health Connect already provide workouts (auto-detected on Apple Watch), sleep, HRV, resting HR, steps, and scale weight — a large share of the scientifically useful data at *zero* user effort. **Rule: don't build manual entry for anything the platform already gives us.** Read first, ask second.

**3. Be honest that BJJ resists passive capture.** Many gyms and virtually all competitions don't allow a watch, and a watch under a gi sleeve is unpleasant. So BJJ realistically means either start/stop from the phone in the bag, or retroactive entry — which is why:

**4. Retroactive logging is first-class, not an edge case.** Most BJJ sessions get logged that evening or the next morning. "Add a past session" cannot be buried behind an edit flow. The offline-first design already supports this correctly — `occurred_at` is client-supplied and distinct from `created_at`, which was the right call and pays off here.

**5. Templates over free entry for strength.** "Last time: 5×5 @ 100 kg" → tap → prefilled → change only what differed. Nobody should type a whole workout twice.

**6. One number captures most of the signal.** Session RPE (1–10) after training, one tap on a scale, is the highest information-per-tap element in the entire app — see §5. If we only ever get one input from a user, it should be this.

### Platform capabilities worth using — and what they cost us

Modern iOS/Android give real reductions in friction: **App Intents / Siri Shortcuts** ("log BJJ"), **Live Activities / Dynamic Island** for an in-progress session, **home-screen widgets** showing today's readiness, **actionable notifications** (log directly from the notification, never opening the app), and an **Apple Watch complication**.

**These have a concrete architectural cost that matters right now:** essentially none of them work in **Expo Go**. HealthKit, widgets, Live Activities, and App Intents all require native modules and therefore a **custom Expo dev client** and EAS builds. Expo Go was the right call for the shell phase; the phase ends the moment we start on real logging UX. That transition should be planned as its own increment, not discovered mid-feature.

## 5. What to collect so the data is scientifically useful

The distinction that matters: **external load** (what you did) vs **internal load** (what it cost you). Most apps only capture the first, which is why their "insights" are thin.

**External** — tonnage (sets × reps × weight), mat time, rounds, distance, pace.
**Internal** — **session RPE × duration** (the Foster sRPE method): cheap, one tap, and the best-validated way to put a BJJ round and a squat session in the same unit. This is the mechanism that makes the unified Load dial real rather than a slogan.

**Recovery** — sleep duration and quality, morning HRV (rMSSD, on waking), resting HR, subjective soreness/mood/stress. HRV is only comparable against itself when measured the same way at the same time of day, so the app must enforce that consistency or the number is noise.

**Performance** — estimated 1RM per lift over time, bodyweight trend (not daily weight), HR at a fixed effort.

**Nutrition** — calories, and protein in **g/kg bodyweight** (the meaningful unit; raw grams aren't comparable between athletes). Weight trend is the ground truth for whether intake matches expenditure — it's the feedback loop that keeps the other numbers honest.

**On ramp rate and ACWR:** acute:chronic workload ratio (7-day vs 28-day load) is the usual tool here, and we should compute it — but its original injury-prediction claims have been substantially challenged in the literature, and we should not repeat them. Use it as a **ramp-rate guardrail** ("your load jumped 60% week over week") rather than an injury predictor. That framing is defensible; "you have an X% injury risk" is not.

### Three things that make this scientific rather than a data pile

1. **Store the inputs, rule version, and explanation with every recommendation** — already decided, and genuinely uncommon. It's what makes a recommendation auditable a year later.
2. **Capture the counterfactual.** When VOLA says "go easy" and the user trains hard anyway, that's the single most valuable row in the database. Log adherence explicitly, without judgement.
3. **Be honest about n=1 confidence.** Three weeks of one person's data does not support a strong claim. The UI should show confidence and degrade gracefully — which is the same principle as the existing "no shame-based messaging, auditable recommendations" stance.

## 6. Mobile-first, desktop as amplifier

Agreed and worth stating as a rule: **mobile is complete.** Log, plan, full calendar, review — all of it, on the phone. A user who never opens the web app misses nothing they need weekly.

Desktop earns its place only where a large screen genuinely changes the task:

- multi-week calendar planning with drag-and-drop
- side-by-side lift comparison and long-range charts
- bulk edits, CSV/data export
- reading a long weekly review

**The rule: nothing a user needs weekly may be desktop-only.** This also resolves the current asymmetry honestly — `apps/web`'s visual style predates the design system, and rather than restyling it to match mobile pixel-for-pixel, it should be *rebuilt around what desktop is actually for*.

## 7. Visual direction: WHOOP-like, and where the analogy breaks

What actually produces that feel:

- near-black background, content floating on it, no chrome
- **one dominant number per screen**, very large type
- a single accent that **encodes state** rather than decorating — VOLA's lime/green gradient maps onto this naturally, with the palette's navy as the ground
- circular progress rings as the signature element
- separation by generous negative space, not borders and dividers
- second-person, plain-language prose: "You're recovered. Good day to go hard."
- a scrollable card feed of insights *below* the hero number, never competing with it

**Where the analogy breaks, and it matters:** WHOOP has continuous physiological data from a dedicated 24/7 wearable. VOLA will not, unless a given user happens to own one. A Readiness score computed from sleep and self-reported soreness is a genuinely weaker signal than one computed from continuous HRV — and presenting it with the same confident precision would be fake precision, which contradicts the project's own stated principles.

So: **show the confidence, degrade gracefully, never invent a number.** With a wearable, Readiness is a percentage. Without one, it's a three-state band (ready / moderate / back off) and says what it's missing. This is a feature, not an apology — it's the difference between an honest tool and an app that guesses convincingly.

## 8. Wearables: recommended, not required — and what that costs

**Decided 2026-07-28: wearables are recommended.** Not assumed, not ignored.

This is the commercially right answer — requiring one shrinks the addressable market sharply, while ignoring them makes VOLA weaker than WHOOP for exactly the athletes most likely to pay — but it is also the **most demanding of the three options to build**, because it means shipping two paths and letting neither feel like a broken version of the other. Four things follow directly:

**1. Integrate with HealthKit / Health Connect, not with wearable vendors.** Apple Watch, Oura, Garmin, Polar, and Fitbit all write into the platform health store. One integration covers most of the market; per-vendor APIs (Oura, Garmin, WHOOP) are a later gap-filler for specific data those devices don't publish, not the starting point. Notably WHOOP's own device is the least cooperative here — worth knowing before promising WHOOP users a seamless import.

**2. HRV is not one number, and this will silently corrupt the data if we ignore it.** Apple Health stores **SDNN**; most HRV research and most other devices use **rMSSD**. They are not interchangeable and must never be compared or averaged across sources. Every biometric sample needs a **`source` and a `metric_type`**, and trend lines must be computed within a single source. A user who switches from an Oura ring to an Apple Watch should see a discontinuity, correctly labelled — not a smooth line that quietly means nothing.

**3. HRV is only meaningful against the individual's own rolling baseline**, which needs roughly 2–4 weeks to establish. Onboarding must say so plainly — "this number starts meaning something around week three" — rather than showing a confident score on day two. Same honest-confidence principle as everywhere else.

**4. "Recommended" must never become a permanent upsell.** The obvious degeneration is a nag banner on every screen for wearable-less users, which is precisely the shame-based messaging the project ruled out. The rule: **mention a wearable at onboarding and once in the Readiness explainer, and nowhere else.** The no-wearable path shows a band instead of a score, uses subjective inputs plus sleep, and is otherwise a complete product.

**Data-model consequence:** biometric samples are their own domain (not activities) and carry `source`, `metric_type`, `measured_at`, and a quality/confidence marker. The recommendation engine already stores its inputs, rule version, and explanation with every output — that extends naturally to recording *which inputs were available*, so a low-confidence recommendation is auditable as such after the fact.

---

## Open questions for discussion

1. ~~Is a wearable assumed, recommended, or irrelevant?~~ **Resolved 2026-07-28: recommended.** See §8.
2. **What's the sRPE prompt's timing?** Immediately post-session is most accurate but least likely to happen; next-morning is reliable but recall-biased. Probably: prompt at session end via notification, fall back to the morning.
3. **When do we leave Expo Go?** Suggested: before the first real logging increment, since HealthKit and widgets are the core of §4 — and §8 makes HealthKit load-bearing, which strengthens the case for doing it early.
4. **Does the exercise/technique library ship with the strength module or before it?** It's a content and licensing project as much as a code one — see the media-storage decision needed alongside it.
5. **How much planning is automatic?** The MVP scope deliberately excludes auto-generated programs. Does "Plan" then mean the user places sessions manually and VOLA only flags conflicts? (Recommended for MVP — it's honest, and conflict-flagging is the differentiator anyway.)
