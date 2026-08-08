# Health platform integration — HealthKit and Health Connect

Status: **scope decided, not built**, 2026-08-07.

The first increment is deliberately narrow: **read heart rate for a session's
window, derive zones and one load number, feed that into the suggestions.**
Recovery data, HRV, and writing back to the health store are all researched
below and all deferred — see §10. Every source in the plan is free; §9 has the
costs.

This is the detail pass on [system-design.md §8](system-design.md), which decided
*that* we integrate with the platform health stores rather than with wearable
vendors. It answers the next three questions: **what to read**, **how a logged
session actually picks up heart rate**, and **what has to exist before any of it
works**.

It also corrects system-design §8 on one point of fact. See §5.4.

---

## 1. What the wearable actually buys us

Two different jobs, and conflating them is the first mistake available:

- **Internal load** — what a session *cost*. Read once per session, joined to a
  session we already have. Answers "that roll was harder than it looked."
- **Recovery state** — whether the athlete has absorbed the cost. Read once per
  day, joined to nothing. Answers "can I go hard today."

They have different data, different reliability, different failure modes, and
they should ship separately. Load enrichment is the one that makes the *existing*
product better and should go first; recovery is what makes the Readiness dial
real and depends on a baseline that takes weeks to establish anyway.

Everything below is subordinate to a rule already in
[CLAUDE.md](../../CLAUDE.md) and worth restating: **an in-progress session is a
phone thing.** The health store lives on the device. Web never reads it — web
reads what mobile has already pushed to our backend.

## 2. The join problem — how a session picks up its heart rate

This is the "connect the dots" ask, and it is the part with a non-obvious
answer.

The obvious design is: a session has `started_at` and `ended_at`, so query heart
rate samples in that window. That is the right answer — but only after
considering the alternative, because the alternative is what the platform
documentation steers you toward.

That alternative is joining to the platform's **own workout record**. If the
athlete started a workout on their Apple Watch (or their Garmin/Samsung wrote an
`ExerciseSessionRecord`), the platform holds an authoritative session object —
`HKWorkout` on iOS, `ExerciseSessionRecord` on Android — with its own start,
end, activity type, and *its own associated samples*. On iOS,
`HKQuery.predicateForObjects(from: workout)` returns exactly the samples that
workout owns, with no window arithmetic and no bleed from the walk to the gym.

It is the tidier call, and it is the wrong default. Why is below.

So the join is a two-tier match — **and the window is the default, not the
fallback:**

1. **Window read.** Query samples between `started_at` and `ended_at`. Record
   `hr_source = 'window'` and the sample count, because a window join over four
   samples is not the same evidence as one over four hundred and the model must
   be able to say so.
2. **Anchor refinement.** If a platform workout overlaps the session window
   (overlap threshold, not equality — nobody presses start on two devices in the
   same second), prefer its associated samples and its energy figure, and record
   `hr_source = 'workout'`.

**Window-first is deliberate, and it is the opposite of what the API docs
suggest.** `predicateForObjects(from:)` returns only samples a writer explicitly
*associated* with its workout object — and third-party straps frequently
don't. Whoop and Garmin both write
workouts to HealthKit without correctly attaching the underlying heart rate;
the samples are in the store, they just aren't reachable from the workout.
Anchor-first therefore returns nothing for exactly the users who bought a strap
to be measured accurately.

Apple Watch does associate correctly, so the anchor is worth having — as an
optimization for one writer, not as the primary path.

**Why this matters more than it sounds.** Apple Watch publishes a background
heart rate roughly **every five minutes** when the wearer is still. During a
Workout-app workout it measures **continuously**. That is the entire difference
between a usable HR curve and five numbers. A 60-minute BJJ session logged in
VOLA with no Watch workout running yields on the order of a dozen sparse
samples, several of them taken while the athlete was sitting down. Averaging
those and calling it session HR is fake precision of exactly the kind
system-design §7 rules out.

The consequence is a product requirement, not a technical one: **if the athlete
wants real HR on a session, they have to start a workout on their watch.** Our
options are to say so plainly in onboarding, or to eventually ship a watchOS
app that starts an `HKWorkoutSession` ourselves. There is no third option where
the phone quietly gets dense HR — without an active workout session the sensor
is not sampling at that rate for anyone.

Same shape on Android: dense HR exists when something was actively recording an
exercise session; otherwise `HeartRateRecord` series are sparse.

## 3. What to read

Ordered by what it buys us. **Request nothing below the line you are actually
using** — both stores show the user a per-type consent screen, and a long list
of types for an app that visibly does one thing is how you train people to
decline.

### Tier 1 — makes existing sessions better

| Need | HealthKit | Health Connect |
|---|---|---|
| HR during a session | `heartRate` | `HeartRateRecord` (series) |
| Session avg / max | `HKStatisticsQuery` `.discreteAverage` / `.discreteMax` | aggregate `BPM_AVG` / `BPM_MAX` |
| Energy cost | `activeEnergyBurned` | `ActiveCaloriesBurnedRecord` |
| The platform's own session (join anchor, §2) | `HKWorkoutType` → `HKWorkout` | `ExerciseSessionRecord` |

From these we derive, server-side: average HR, peak HR, time in five zones, and
one internal-load number. **Derive on the backend, not the client** — same
reasoning as `session.Summarise` living in the domain rather than in SQL or a
client, so both platforms report identical numbers.

**The load number should be Edwards' TRIMP**, not Banister's: zone-weighted
minutes, `Σ(minutes in zone × zone weight 1–5)`. It needs only HRmax, produces
a number that maps directly onto the zone bars the athlete is already looking
at, and — the deciding point — Banister's formulation needs *resting* HR, which
drags in a second daily read and a whole recovery pipeline for a Phase 1 that
otherwise doesn't need one.

**HRmax is the one unavoidable input, and `220 − age` is a poor estimator** with
a standard deviation around ±10–12 bpm; on a real athlete it is routinely wrong
by enough to shift two zone boundaries. The honest sequence:

1. Seed from `220 − age` (`profile.date_of_birth` already exists), and **mark
   the session's zones as estimated** wherever they are shown.
2. Replace it with the **observed maximum across the athlete's own history** as
   soon as there is one — with a strap sampling every second, a few hard
   sessions produce a better number than the formula ever will.
3. Never silently switch between them. Which HRmax produced a given session's
   zones belongs in `session_metrics` alongside `hr_source`, for the same
   reason.

**VO₂max is read, never computed.** It is a device-written estimate
(`vo2Max` / `Vo2MaxRecord`) that appears as a daily-ish value, not something a
session window yields — and most devices estimate it from steady-state running,
so a VO₂max that moved after a BJJ session did not move *because* of it. Show
it as a trend on the athlete's profile; do not attach it to a session.

### Tier 2 — makes Readiness real

| Need | HealthKit | Health Connect |
|---|---|---|
| Resting HR | `restingHeartRate` | `RestingHeartRateRecord` |
| HRV | `heartRateVariabilitySDNN` | `HeartRateVariabilityRmssdRecord` |
| Sleep | `sleepAnalysis` (category) | `SleepSessionRecord` |
| VO₂max | `vo2Max` | `Vo2MaxRecord` |
| Respiratory rate | `respiratoryRate` | `RespiratoryRateRecord` |
| SpO₂ | `oxygenSaturation` | `OxygenSaturationRecord` |
| Wrist / skin temperature | `appleSleepingWristTemperature` | `SkinTemperatureRecord` (feature-flagged) |

**Resting HR is the most valuable field in this table** and the one nobody talks
about: it is written by essentially every device including Whoop and Oura, it
needs no interpretation, and a multi-day elevation is a genuine and legible
overreaching signal. If we shipped one recovery metric, it would be this one —
not HRV. See §5.4 for why.

Sleep is worth reading at stage granularity where it exists (`asleepCore`,
`asleepDeep`, `asleepREM`, `awake`; `inBed` is all an iPhone alone can give)
but worth *using* only at duration granularity until we have a reason
otherwise. Stage-level sleep scoring is a place to invent precision we can't
defend.

### Tier 3 — context and body composition

| Need | HealthKit | Health Connect |
|---|---|---|
| Body mass | `bodyMass` | `WeightRecord` |
| Body fat % | `bodyFatPercentage` | `BodyFatRecord` |
| Lean mass | `leanBodyMass` | `LeanBodyMassRecord` |
| Height | `height` | `HeightRecord` |
| Steps | `stepCount` | `StepsRecord` |

Body mass earns its place immediately: it makes tonnage relative, it feeds
nutrition targets, and BJJ athletes weigh themselves for competition anyway —
reading the scale is strictly better than asking. It also satisfies §2's
"passive capture first" rule at its cheapest: `profile` currently has no weight
field at all, and this is the argument for never adding a manual one.

Steps are the weakest item here and the most likely to be cut. "You also walked
18k steps" is context; it is not load.

### Deliberately not read

Nutrition (we own that domain and reading someone else's macros creates a
reconciliation problem we don't want), cycle tracking, blood glucose, blood
pressure, mindfulness. Every one of these is a type on the consent screen and a
line on the Play declaration form for no return.

## 4. What to write back

**Write VOLA sessions into the health store as workouts** — `HKWorkout` via
`HKWorkoutBuilder`, `ExerciseSessionRecord` on Android.

This is cheap and it is the single highest-leverage retention feature in the
whole integration. An athlete's rings close. Their session shows up in the
Fitness app next to their runs. Every other app they use sees that they trained.
An app that reads and never writes is a parasite on the health store and users
notice.

Activity type mapping — HealthKit's enum is granular, Health Connect's is
coarser:

- **BJJ** → `HKWorkoutActivityType.martialArts` (28). `.wrestling` (56) is
  arguably the closer physiological match but `martialArts` is the honest
  label and the one the athlete will expect to see. Health Connect's exercise
  type enum has a martial-arts entry — **confirm the exact constant against the
  current `ExerciseSessionRecord` constant list before relying on it**, it was
  not verifiable from the docs during this research.
- **Strength** → `.traditionalStrengthTraining` (50) for barbell work,
  `.functionalStrengthTraining` (20) for everything else. Health Connect:
  `EXERCISE_TYPE_STRENGTH_TRAINING`.
- **Running** → `.running` (37).

**Two rules on the write side, both about not lying:**

1. **Never write a measurement we did not measure.** We may write the workout
   envelope, its duration, and its type. We may not write heart rate — we don't
   have a sensor. We may not write an *estimated* energy burn as though it were
   measured. Guideline 5.1.3 prohibits writing inaccurate data to HealthKit,
   and independently of Apple's opinion it would corrupt the athlete's own
   record.
2. **A workout we write must not double-count one the watch already recorded.**
   If the athlete ran a Watch workout for the same session, there are now two
   overlapping workouts in the store. The rule: **write only when the anchor
   match in §2 found nothing.** If the platform already has this session, ours
   is a duplicate, not a contribution.

## 5. Five facts that break the naive design

### 5.1 iOS cannot tell you that read access was denied

By design, and it is not a bug to work around. `authorizationStatus(for:)`
reports *sharing* (write) status only. For reads, a denial is indistinguishable
from an empty store — Apple treats "the user has data of this type" as itself
private. So there is no reliable "you haven't granted permission" banner
available.

What this forces: the UI can only ever say **"no heart rate data for this
session"**, never "you denied us." And a first-run that returns nothing must
not be treated as a failure — it is the *expected* result for an athlete with
no wearable, which is most of them. Any code path that reads emptiness as
misconfiguration will be wrong for the majority of users.

### 5.2 Health Connect has a 30-day wall and two extra permissions

By default a read permission grants the previous **30 days** of other apps'
data. Reading anything older requires
`PERMISSION_READ_HEALTH_DATA_HISTORY`, and attempting to read a single older
record without it is an *error*, not an empty result. Reading at all while
backgrounded requires `READ_HEALTH_DATA_IN_BACKGROUND`. Both are declared
separately, both are gated on Play review, and background reads need a
feature-availability check because older Health Connect versions don't support
them.

The consequence for onboarding: on Android, "import my history" is a distinct
permission with a distinct justification, and if we don't ask for it, a new
user's backfill silently stops at 30 days.

### 5.3 Deduplication is our problem, not the platform's

On iOS, `HKStatisticsQuery` / `HKStatisticsCollectionQuery` de-duplicate across
sources using the user's own source-priority order in the Health app.
`HKSampleQuery` does not — it returns everything from every source, and if the
athlete has both an iPhone and a Watch, or a Watch and a Garmin, the same
minute of activity appears more than once.

Rule: **use statistics queries for anything aggregated** (avg HR, total energy),
and reserve sample queries for cases where we genuinely want the series and will
attribute each sample to its `HKSource` ourselves. Every stored sample carries
its source regardless — system-design §8 already required this, and it is also
what makes the dedupe auditable later.

### 5.4 HRV is not portable — and it is worse than system-design §8 assumed

System-design §8 says Apple stores SDNN while most devices use rMSSD, and that
the two must never be compared. That is correct and remains the rule. But the practical
situation is worse than a units mismatch:

**Whoop and Oura do not write HRV to Apple Health at all.** Whoop states the
reason explicitly — their rMSSD is not Apple's SDNN, so rather than write a
misleading number they write none. Garmin's HealthKit export has the same gap.
Whoop additionally does not write per-workout heart rate correctly, and Garmin
shares that defect.

So on iOS, "HRV-based readiness" means **Apple Watch users only**, and even
then it means SDNN, which is not the metric the research literature is written
about. Meanwhile Health Connect has a first-class
`HeartRateVariabilityRmssdRecord` — Android is, on this one axis, the better
platform.

**One notable exception: Amazfit/Zepp does write HRV to Apple Health**, along
with VO₂max, resting HR, sleep, SpO₂ and respiratory rate. Support is recent
and device-limited, so it can't be generalised to "Amazfit users are covered."
It also raises a question worth answering before trusting the number: HealthKit
has exactly one HRV field and it is SDNN, so a vendor computing rMSSD either
converts it or writes rMSSD into the SDNN slot — the latter would be silently,
invisibly wrong. **Verify against a known reading before using Zepp-sourced HRV
for anything.** This is precisely why `source` is on every sample.

Three things follow:

- **HRV cannot be load-bearing for Readiness.** It is a bonus input for one
  hardware configuration. Resting HR and sleep — available nearly everywhere —
  carry the score.
- **The "wearable" path is not one path.** An athlete with a Whoop gets sleep,
  RHR and workout energy but no HRV and unreliable session HR. Design the
  degradation per *field*, not per "has wearable / doesn't."
- **Per-vendor APIs move up the roadmap for exactly this reason.**
  [system-design.md §8](system-design.md) called them a later gap-filler. This
  is the gap: the data Whoop and Oura users are paying for is the data their
  devices refuse to publish. See §9 — for Whoop specifically the fix is cheaper
  than the problem, which is why the ordering below changed.

### 5.5 The wrist is the wrong place for a gi

Optical HR degrades under grip, wrist flexion, and contact — the three things
grappling consists of. The general finding in the validation literature is that
wrist PPG is good during running and materially worse during activities with
sharp, random arm movement and gripping; grappling is the pathological case, and
sleeve/gi pressure over the sensor makes it worse.

**The fix is placement, and it is a real one.** An upper-arm strap sits off the
wrist entirely, away from the flexion and the grips, closer to the heart, under
the sleeve rather than under a lapel grip. The Amazfit Helio Strap samples every
second from that position and is explicitly designed for the
gripping/flexing/sweating case. For a BJJ athlete this is the correct hardware
answer, and it is worth saying so in onboarding: **an armband beats a watch for
grappling**, which is advice no competitor is giving because none of them are
BJJ-first.

That does not lift the constraint for everyone. Most athletes will arrive with a
wrist device, so the *design* still has to survive bad HR. It is a reason to
hold a specific line: **session RPE stays the primary internal-load metric for
BJJ, and heart rate corroborates it.** sRPE is a well-validated internal-load
measure that correlates with HR-derived TRIMP in the 0.65–0.78 range across
team sports, it
requires no hardware, and it does not care that someone had a lapel grip across
the athlete's watch for four minutes. The existing `session_rpe` on BJJ sessions
is already the right primitive — HR should make it more confident, never
replace it.

For strength and running, wrist HR is fine and the ordering can be reversed.

## 6. What we have to build

### 6.1 Leave Expo Go — this is the real cost

None of this runs in Expo Go. Not the iOS side, not the Android side. Both
require native modules, therefore `expo prebuild` and a custom dev client,
therefore EAS builds and a signing/distribution story we do not currently have.

This is [system-design.md](system-design.md)'s open question 3, and this research
answers it: **the health integration is the forcing function.** It is worth
noting the exit is not a cost paid only for this — widgets, Live Activities and
App Intents are all behind the same door, and CLAUDE.md's existing note that
"you cannot verify a mobile screen through Expo web" gets *better* after the
move, not worse.

Libraries, both with Expo config plugins:

- **iOS** — `@kingstinct/react-native-healthkit` (Nitro modules, New
  Architecture, actively maintained) or `react-native-health` (older, wider
  install base). Prefer the former on the New Architecture; RN 0.86 / Expo 57
  compatibility needs verifying against whatever is current at build time.
- **Android** — `react-native-health-connect` (matinzd), plus
  `expo-build-properties` to set `minSdkVersion` 26 and matching
  compile/target SDKs.

There is no single cross-platform library worth using. The abstraction is ours
to write, which is fine, because the two stores are not actually
interchangeable (§5.2, §5.4) and a library that pretends they are would hide
exactly the differences we need to reason about.

### 6.2 Mobile: one module owns the health store

Same discipline as [`lib/session.ts`](../../apps/mobile/lib/session.ts) and
Clerk. **Exactly one module may call HealthKit or Health Connect.** The Clerk
lesson is directly applicable: nine modules independently reading a null
`getToken()` as "signed out" made a gym dead-spot look like a mass sign-out. The
equivalent here is nine modules independently reading "no samples" as "no
permission" (§5.1), and the fix is the same shape — a single facade with an
honest return type.

Sketch:

```
lib/health/
  index.ts        — the facade. Everything else imports only this.
  provider.ts     — HealthProvider interface; iOS and Android implementations.
  ios.ts          — HealthKit
  android.ts      — Health Connect
  enrich.ts       — the §2 two-tier join, pure and unit-testable
  anchors.ts      — HKQueryAnchor / Health Connect changes-token persistence
```

`enrich.ts` should be pure over injected samples so it can be tested without a
device — that is exactly the class of logic
[`apps/mobile/lib/__tests__/`](../../apps/mobile/lib/__tests__/) exists for
("what breaks in this app is concurrency and state reconciliation, not
rendering"). The join in §2 has real edge cases — overlapping workouts, a
session that spans midnight, a watch workout that starts before ours — and every
one of them is testable on a laptop.

**New local SQLite table for anchors.** Incremental sync on both platforms is
anchor-based; the anchor must survive app restarts or every sync re-reads
everything. That is a `SCHEMA_VERSION` bump and a migration branch in
[`lib/db.ts`](../../apps/mobile/lib/db.ts).

### 6.3 Backend: a new `biometric` module

**Not `health`.** That name is taken by operational telemetry
(`internal/modules/health` — server errors and sync-blocked events) and the
collision would be genuinely confusing in a codebase where module name is the
first thing anyone reads. `biometric` is the name system-design §8 implicitly
asked for when it said "biometric samples are their own domain."

Following the `profile` reference pattern — `biometric.go`, `postgres.go`,
`handler.go`, migration, `postgres_test.go`, wired under `/v1`, OpenAPI entry.

Two tables, because they answer different questions:

**`biometric_samples`** — the raw record, one row per reading.

```
id              text primary key   -- client-generated, per activities' idempotency pattern
user_id         text not null
metric_type     text not null      -- 'heart_rate' | 'resting_heart_rate' | 'hrv_sdnn' |
                                   -- 'hrv_rmssd' | 'sleep_duration' | 'body_mass' | ...
source          text not null      -- 'apple_watch' | 'oura' | 'whoop' | 'garmin' | 'manual'
source_platform text not null      -- 'healthkit' | 'health_connect'
value           double precision not null
unit            text not null
measured_at     timestamptz not null
period_end      timestamptz        -- null for instantaneous; set for intervals
```

`hrv_sdnn` and `hrv_rmssd` are **separate metric types, never one `hrv` type
with a unit column**. System-design §8 said don't compare them; making them the
same enum value is how someone eventually does. Trends are computed within
`(metric_type, source)` and a source change renders as a labelled discontinuity.

**`session_metrics`** — the derived per-session enrichment, one row per session.

```
session_id      text primary key references sessions(id) on delete cascade
avg_hr_bpm      int
max_hr_bpm      int
active_kcal     int
trimp           double precision
time_in_zones   jsonb
hr_source       text not null      -- 'workout' | 'window' | 'none'   (§2)
sample_count    int not null
computed_at     timestamptz not null
rule_version    int not null
```

`hr_source` + `sample_count` are the honest-confidence fields and they are not
optional. System-design §7's rule — show the confidence, never invent a number — is
unenforceable if the enrichment doesn't record how good its own evidence was.
`rule_version` matches what §8 already requires of the recommendation engine:
store the inputs and the rule version alongside every output.

Idempotency throughout: client-generated IDs and `ON CONFLICT DO NOTHING`, the
same thing that already makes activity sync retries safe.

### 6.4 Sync

Direction is new. Existing sync is *push*: local write → outbox → `POST`. Health
data is **pull-then-push**: read from the OS, transform, then push. The outbox
mechanism carries over unchanged; the anchor persistence in §6.2 is the new
part.

Enrichment is **not** blocking. A session syncs when it syncs; its metrics
arrive later, possibly much later — the athlete's watch may not have written its
samples yet when they close the app. `session_metrics` being absent is a normal
state, not an error, and the UI has to render a session with no HR row without
looking broken.

### 6.5 Contracts and docs

`contracts/public.openapi.yaml` entries for the new endpoints;
[functional-scenarios.md](../testing/functional-scenarios.md) gets the scenarios
(permission denied, permission granted but no data, wearable removed mid-history,
duplicate sources, 30-day wall on Android); README's "Current state" gets the
new module; and this lands in [history.md](history.md) when it does.

## 7. Store review and legal — start this early, it is not a formality

**Apple.** HealthKit capability in the entitlements; `NSHealthShareUsageDescription`
and `NSHealthUpdateUsageDescription` purpose strings (a missing one is a crash,
not a warning); a privacy policy linked in App Store Connect *and* in the app;
App Privacy details declaring health data collection. Guideline 5.1.3: health
data may not be used for advertising or marketing, may not be sold to data
brokers, and must not be stored in iCloud. Note we *do* store it on our own
backend — that is allowed, and it is exactly what the privacy policy has to say
plainly.

**Google.** The Health apps declaration in Play Console is mandatory for every
app, and a permissions declaration is required for each health data type,
including a **video demonstration** of the in-app feature each permission serves.
Background reads and history reads are declared and justified separately. You
cannot ship *any* store update — including store listing changes — while a
permissions alert is open.

**Both.** Resting heart rate, sleep and HRV stored against a user identity is
health data under GDPR Article 9 special category. Whatever we do about
retention, export and deletion needs to be decided before the first row is
written, not after. This is the one part of the integration where "we'll tidy it
up later" has a legal cost.

## 8. What the enrichment actually feeds

Three uses, in ascending order of how much they justify the work:

**1. Session review — "how did that go."** Zone bars, peak HR, minutes in Z4/Z5,
compared against the athlete's own recent sessions. Cheap, immediate, and it is
what the athlete will open the app to look at.

**2. Load, cross-sport.** Edwards TRIMP is a single comparable number across BJJ
and strength, which is exactly the thing [system-design.md §2](system-design.md)
needs to move one Load dial from four disciplines. Weekly HR load is a
measurement where the current one is an estimate.

**3. Calibrating sRPE against measurement — the one nobody else has.** We hold
both signals: the athlete's self-reported session RPE, and what their heart
actually did. When someone's RPE-6 sessions consistently show 20 minutes in
Z4/Z5, their self-report is running low, and we can say so — and correct for it
in every session they log *without* a strap. That is the cross-signal insight
the strap pays for, and it makes the no-wearable path better rather than merely
tolerable. It also runs the right way round: measurement calibrates the
subjective scale, it does not replace it (§5.5).

## 9. Reading directly from Whoop and Garmin

**These are a different shape of work from everything above.** The health stores
are a device integration: native modules, per-platform, phone-only. A vendor API
is a *backend* integration — OAuth plus webhooks, server-side. Three consequences
that make it more attractive than its position in
[system-design.md §8](system-design.md) implied:

- **Not blocked on the dev client.** No native code, so it can proceed in
  parallel with, or entirely without, §6.1.
- **Web gets it too.** Data arrives at our backend, not at a phone, so the
  analytical surface has it without mobile syncing anything.
- **It is the same integration on both platforms.** One implementation, not two.

### Whoop — free, self-serve, and it closes the §5.4 gap

Access to the Whoop Developer Platform is **free**. There is no fee, no revenue
share and no commercial agreement in either the approval documentation or the
API Terms of Use. The only cost is that a tester needs a Whoop membership,
which their users have by definition.

**You can build and test the whole thing today**: an unapproved app works
immediately for up to **10 Whoop members**. Approval is required only to go
beyond that, and the bar is administrative rather than commercial:

- comply with the Whoop API Terms of Use
- have tested with at least one Whoop member
- accurate App Name, contact email(s) and **privacy policy URL** in the
  Developer Dashboard
- adhere to Whoop's design and brand guidelines
- submit an app-submission form including designs and context

No timeline is published, which is the one unknown worth planning around — treat
approval as a lead-time item, not a launch-day one.

Rate limits are roughly 100/minute and 10,000/day, raisable on request. It
returns cycles, recovery, sleep, workouts and body measurements — **including
HRV as genuine rMSSD and a recovery score**, which is precisely the data Whoop
refuses to write to HealthKit.

**One licensing term matters to a paid product and should be read before
building.** Whoop's terms prohibit selling, renting or redistributing access to
Whoop services, and prohibit marketing, selling or licensing API-transferred
data to third parties. They explicitly *permit* charging for functionality the
Whoop platform does not itself provide. VOLA's subscription is that — we charge
for cross-sport planning, not for Whoop's data. The line to never cross is
anything that resells or brokers the data itself.

### Garmin — no fee, but enterprise-gated

Garmin's own program FAQ states there are **no licensing or maintenance fees**,
that the program "is only for business use," that application status is
confirmed within two business days, and that integration typically takes one to
four weeks. Some metrics may carry licensing fees or minimum device orders for
commercial use.

**Treat third-party claims about Garmin access with suspicion.** Several
aggregator vendors' blogs assert a ~$5,000 setup fee and that new onboarding is
paused; Garmin's own page contradicts the fee and reads as though applications
are open. Those vendors sell the alternative, so this is marketing until
verified directly. Verify before planning around either version.

Unlike Whoop this is not self-serve — it needs a legal entity and a manual
business review. Reasonable later; not a first integration.

**Oura has a public API as well but was not researched here.** Given §5.4 puts
Oura users in the same hole as Whoop users, it is worth the same look before the
per-vendor phase is scoped.

### The treadmill, and when to stop paying it

Each vendor is its own OAuth app, token refresh and storage, webhook endpoint,
data-model mapping and API-versioning obligation. Two is fine. Around five or
six it becomes a product of its own, and that is the point where aggregators
(Terra, Rook, Vital, Spike) start earning their per-user fee. **Do not start
with an aggregator** — paying per user to solve a problem we have with one
vendor is the expensive way round.

### What each source costs

| Source | Cost | Gate |
|---|---|---|
| HealthKit | Free | Apple Developer Program ($99/yr), already required for EAS builds |
| Health Connect | Free | Play Console declaration + per-permission review |
| Amazfit / Zepp | Free | None — writes into both stores, nothing to integrate |
| Whoop API | **Free** | Self-serve to 10 users; administrative approval beyond |
| Garmin API | No fees stated | Business-only, manual review, some metrics licensed |
| Aggregators | Paid, per-user | None — that is what you are buying |

**Everything in the first increment is free.** Amazfit reaches us through
HealthKit at no cost and with nothing to build beyond §2's window read; Whoop
costs nothing but an approval form. There is no paid dependency anywhere in the
plan below.

## 10. Recommended sequencing

Scope decided 2026-08-07: **window read, quick analysis, feed the suggestions.**
Everything below Phase 1 is explicitly deferred, and §4's write-back, §3's Tier 2
recovery pipeline, and HRV entirely are out of the first increment.

**Phase 0 — leave Expo Go.** Prebuild, dev client, EAS. No health code. Its own
increment, its own PR, verified by the existing app still working. This is not
optional and not skippable: **there is no "simple" version of this integration
that runs in Expo Go.** Do not discover it mid-feature.

**Phase 1 — iOS read, session enrichment only.** Heart rate and active energy,
the §2 window join, `biometric_samples` + `session_metrics`, zone bars and one
load number on the session detail screen with their confidence shown. One
platform, one job.

**Phase 2 — Whoop direct.** Revised 2026-08-08, and it displaces Health Connect
from this slot. Three reasons it goes before the second health store: it is
**backend-only**, so it is not blocked on Phase 0 and could even run alongside
it; it is **self-serve to 10 users**, so it can be prototyped before any
approval; and it is the only thing that fixes §5.4 for the athletes most likely
to pay. Health Connect makes VOLA work for *more* people; Whoop makes it work
*properly* for the ones already carrying the best data.

**Deferred, in the order they'd earn their way back:** Health Connect parity
(the 30-day wall, background-read permission and Play declaration are each
distinct work, and doing them while debugging the join confuses two problem
spaces); write-back as workouts (§4, small and high-value once Phase 1 has
proven itself); daily recovery — sleep, resting HR, body mass (§3 Tier 2), which
is what eventually turns Readiness from a self-report into a measurement; Oura
and Garmin (§9), on evidence of real demand; a watchOS app, the only route to
dense HR for athletes who don't wear a strap, and justifiable only from observed
Phase 1 data — specifically how many enrichments come back with a low
`sample_count`. That field exists partly to answer this question.

**A note on what Phase 2 does to Phase 1's data model.** Whoop arrives as
server-side rows with no device in the loop, which is a good stress test of
§6.3: `biometric_samples` carries `source` and `source_platform` precisely so a
Whoop rMSSD row and an Apple SDNN row can coexist without anyone averaging them.
If the Phase 1 schema needs changing to accept Whoop, it was wrong in Phase 1.

**One option worth recording rather than pursuing.** The Helio Strap can
broadcast live HR over standard BLE (Zepp's "Heart Rate Push"), as can most
chest straps. VOLA could read that directly during a session and skip the health
store entirely — real-time HR, no watchOS app, both platforms at once. It is a
materially larger native lift (BLE permissions, background scanning, a pairing
UX) and it only serves athletes whose device broadcasts, so it is not the
starting point. But it is the cheapest route to *live* in-session HR, and it is
a better answer than a watchOS app if that ever becomes the goal.

---

## Open questions

1. **Do we ask for permissions at onboarding or at first use?** First-use is
   better for grant rates and better for honesty (the athlete has just finished
   a session and can see what the permission is for), but it means the first
   session enriched is the second session logged. Recommended: first use, on the
   session detail screen, with a backfill of the previous 30 days on grant.
2. ~~What is `hr_max` derived from?~~ **Resolved 2026-08-07:** seeded from
   `220 − age`, labelled estimated, replaced by observed maximum. See §3.
3. ~~Does TRIMP earn its place?~~ **Resolved 2026-08-07:** Edwards' zone-weighted
   form, which avoids needing resting HR. See §3.
4. ~~Per-vendor APIs — how much sooner?~~ **Resolved 2026-08-08:** Whoop moves
   to Phase 2, ahead of Health Connect. It is free, backend-only, and self-serve
   to 10 users. See §9. Oura still needs the same research pass; Garmin waits
   for a business case.
5. **What is the retention policy for biometric samples?** See §7. Needs an
   answer before the first write, not after.
6. **When do we apply for Whoop approval?** No review timeline is published, and
   the 10-member limit binds the moment there are 11 interested users. Applying
   early costs an afternoon and de-risks a launch; applying late is a hard stop.
   Recommended: apply as soon as Phase 2 has a working prototype and a privacy
   policy URL that resolves — note that URL is also required by Apple (§7), so
   it is one piece of work serving two gates.
