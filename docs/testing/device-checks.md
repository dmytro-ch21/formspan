# Device checks — what has never run on real hardware

A walkable script for the things this repo cannot test. Each item says **what to
do on the phone**, **what should happen**, and **what failure looks like**. You
should not need to read any code to run one.

This is the companion to [functional-scenarios.md](functional-scenarios.md), and
the split is deliberate. That file lists what a test *could* assert. This one
lists what **no test can reach**: a camera, a microphone, a keyboard, a real
photograph, a permission prompt, a notch, a speaker, a gym with no signal. Those
are not gaps in the suite — they are outside it.

**Related:** issue [#380](https://github.com/dmytro-ch21/formspan/issues/380)
(L1) is the standing list of surfaces built and never seen. This document is the
method for shrinking it.

---

## How to use this

- **Do the top five first.** They are ranked by expected harm × likelihood, and
  five is what fits in one sitting. The rest is a reference list, not a queue.
- **Build from the primary checkout, not a worktree.** A worktree build silently
  ships an app with no Clerk key and no API URL — see CLAUDE.md. Release build
  for anything you carry around; a Debug device build dies the moment your Mac
  stops serving it.
- **Confirm which build you are looking at** before trusting a screenshot. A dev
  client's launcher can be pointed at another Metro.
- **A Simulator cannot do most of this.** It has no camera, no dictation key, no
  ringer switch and no haptics. Every item below is tagged with where it can run.
- **File what you find as its own issue; don't fix it inline.** A device session
  that turns into a debugging session stops being a device session.

---

## How this list was built, and what each method found

Three methods, deliberately, because one grep has burned this repo repeatedly —
including on this ticket.

1. **Filesystem walk of the route tree** (`app/**`) — 55 mobile route files, plus
   the subagent's walk of `apps/web/src/app/**` and `apps/admin/src/app/**` (43
   pages). This is the only method that can see a screen nothing references.

2. **Static import analysis of every test file** — which module does each test
   actually import, minus what it `jest.mock`s. **This method was wrong on its
   first run**: it resolved only relative specifiers, and this codebase imports
   screens as `@/components/...`. Four tests came back as covering nothing when
   they cover four real components. Corrected and re-run.

3. **A measured jest coverage run** over `app/**` and `components/**`, as the
   independent check on method 2. The two agree exactly: **44 of 93 screen and
   component files execute zero statements under the whole suite**, and all 31
   routes method 2 flagged appear in that list.

Method 3 also produced a false alarm worth recording: under `--coverage` two
suites failed, which looks like a red baseline. It is the instrumentation
pushing them past jest's `testTimeout`. **The plain suite is green in the same
session — 118 suites, 1757 tests, 16.3s** — so the failures measured my
apparatus, not the code. Do not go chasing them.

### The numbers this rests on

| | |
|---|---|
| Mobile statement coverage, `app/` + `components/` | **33.1%** |
| Mobile screens/components executing **zero** statements | **44 of 93** |
| Mobile routes with no test that renders them | **31 of 55** |
| Web + admin pages with a test that renders them | **0 of 43** |
| Web + admin tests that run in a browser-like DOM | **0** (both suites are `environment: "node"`; no jsdom) |
| Playwright specs committed to this repo | **0** (`tests/functional/` is not tracked here) |

The mobile suite's shape is a defensible choice — it covers concurrency and
state reconciliation, because that is what breaks. The consequence is simply
that **rendering is genuinely unverified**, and this document is the answer to
that rather than a complaint about it.

---

# The top five

Do these. If you do nothing else, do these.

---

## D1 — Photograph a gym machine to identify it

**Where:** iPhone only. The Simulator has no camera; this path cannot be reached
there at all.

**Do:** Start a strength session. Tap to add an exercise, then
**"Don't know its name? Photograph the machine"**. Allow the camera when asked.
Photograph an actual machine in an actual gym — from where you would really
stand, with the gym's own lighting, on the gym's own wifi. Then do it a second
time on cellular with one or two bars.

**Should:** The camera opens, the shot is accepted, and within a few seconds you
get a named candidate you can pick and add to the session. If it cannot tell,
it should say so and offer **"Take another"**.

**Failure looks like:** A spinner that ends in *"Try again when you have
signal"* while you are plainly on wifi with four bars. That is this screen's
signature bug — it shipped uploading a full 48-megapixel frame, blew the
server's 8 MB body cap and iOS's 60-second request budget, and reported the
timeout as *your* connection being bad. Also watch for the app dying outright
while the shot is being prepared, and for a candidate that is confidently the
wrong machine.

**Why it is first:** This is the only item on the list that has **already failed
on a real device** (N73). The fix landed and **has never been run on hardware
since**. It sits in the middle of a workout, so an athlete meets it while
holding a barbell, and its failure message actively sends them to debug the
wrong thing.

---

## D2 — Sign in with "Continue with Google"

**Where:** A real build on a phone or Simulator. **Not Expo Go** — the login
comes back through the app's own `vola://` link, which Expo Go cannot deliver.

**Do:** Sign out completely. On the sign-in screen tap **Continue with Google**
and complete it with a Google account that has **never** used VOLA. Then repeat
with an account that already has a VOLA profile. Then a third run where you
**dismiss the browser sheet halfway** instead of finishing.

**Should:** A browser sheet opens, you pick the account, the sheet closes by
itself, and you land inside the app already signed in. Backing out should return
you to the sign-in screen silently — no error, nothing to dismiss.

**Failure looks like:** The browser finishes and **nothing happens** — you are
left staring at Google or at a blank sheet, with no way back into the app. Or
the sheet closes and you are still signed out. Or an error naming a redirect URI
or a scheme.

**Why it is second:** The blast radius is total. Athletes have been creating
accounts through Google on the web since web shipped, and **those accounts have
no password at all** — so for them this button is not a convenience, it is the
only door. It has zero test coverage of any kind and, by the code's own
admission, has never been exercised against a real build. There is also a
second-factor branch after Google that nobody has ever seen fire.

---

## D3 — Share a finished session card

**Where:** iPhone. A Simulator will render the card but its share sheet has
almost nowhere to send it.

**Do:** Finish a session — strength or BJJ, do both if you can. On the finish
card tap **Share**. Read the preview carefully. Then post it to Messages, and
again to Instagram or WhatsApp. **Open the image you actually sent** and look at
it full size.

**Should:** A preview appears *before* anything is shared, and you can back out
of it. What you send is a crisp square card, roughly 1080 × 1080, with the
session photo, the numbers and the wordmark all present and legible.

**Failure looks like:** A **blank, black or half-drawn image** — the card is
drawn off-screen and captured, and off-screen capture is exactly the thing that
breaks quietly. A card with the photo missing because it had not finished
loading when the snapshot was taken. An image that is enormous (multiple MB) or
tiny and blurry — the export size is computed differently on iOS and Android and
that arithmetic **has never produced a real pixel**: the test mocks the capture
library outright and asserts the numbers handed to a stub.

**Why it is third:** This card carries a **calorie figure derived from body
data** and a VOLA score, published to whichever app the athlete picks. Getting
it wrong is not a cosmetic bug, and it is the headline item on #380.

---

## D4 — Photograph a real plate of food

**Where:** iPhone for the camera path; a Simulator can do the photo-library half.

**Do:** From **Food → add**, take the describe path and photograph a real meal —
a plate with several things on it, one of them partly hidden. Read every number
that comes back before saving. Then repeat with a photo picked from your library
instead of the camera, and once more with a deliberately terrible photo (dark,
blurry, at an angle).

**Should:** The photo uploads without a long stall, and you get an **editable
draft** — nothing is logged until you confirm. Items it is unsure about should
be visibly hedged; anything it could not work out should be blank rather than
filled with a guess.

**Failure looks like:** A stall or a timeout on a large photo (same shape as
D1 — this screen and that one prepare images separately). But the dangerous one
is quieter: **a count that is simply wrong and stated flatly.** Two fried eggs
where there was one. The model flags what it invents and does not flag what it
miscounts, so the wrong number arrives looking exactly like a right one. Check
the quantities specifically, not just the names.

**Why it is fourth:** It writes numbers into a food diary that drive targets and
trends downstream, and a wrong number there is invisible forever after. A real
plate has, as far as anyone can tell, never been through it.

---

## D5 — Scan a barcode on a real packet

**Where:** iPhone only — camera.

**Do:** From **Food → add**, tap **Scan**. Read the permission prompt *word for
word before you accept it*. Scan a barcode on something curved and shiny — a
protein tub, a yoghurt pot — in ordinary kitchen light and then in poor light.
Then scan something obscure that will not be in the catalog. Then put the phone
in airplane mode and scan something you already scanned once, and something new.

**Should:** The scan resolves to the exact product with macros off the label.
An unknown barcode says **so**, shows the digits it read, and offers the
describe path. Offline, a barcode you have scanned before still resolves from
the local cache; a new one says it **could not ask**, which is a different
sentence from "we don't have this one".

**Failure looks like:** A camera that never locks focus close-up. A scanner that
fires repeatedly and stacks up duplicate lookups. An **empty screen** where one
of those three outcomes should be — absence reading as an answer. And offline:
"not in our catalog" when the truth is "no signal", which is a false statement
about the catalog.

**Also check the permission prompt itself.** If it asks for the **microphone**,
that is a real bug and only a built binary can show it: both the camera and the
image-picker plugins add a microphone permission unless explicitly switched off,
and no test, lint, typecheck or CI job can see it. What the prompt says is what
App Store review and the privacy label will read.

---

# The rest

Useful, but not what a single sitting is for.

## Camera, microphone, filesystem

### D6 — Dictate a BJJ session

**Where:** **iPhone only, and this one is absolute** — the Simulator's keyboard
has no dictation key, so the feature's entire input method is unreachable there.

**Do:** BJJ → the dictate screen. Tap the **microphone on the system keyboard**
and speak a real session out loud: how long, how many rounds, who with, what you
hit and what got hit on you. Include a technique whose name is ambiguous.

**Should:** Your words land in the field, and the draft that comes back is
editable. Round counts are steppers you can correct with a thumb. Anything the
words did not pin down comes back **blank with a reason**, and an ambiguous
technique offers you a choice rather than pre-selecting the top match.

**Failure looks like:** Dictation cutting out on long speech. The keyboard
covering the field you are dictating into. A count that is quietly one off — the
same flatly-stated miscount as D4. And the failure the design explicitly
forbids: an ambiguous phrase arriving **already ticked**, plausible and one tap
from permanent.

### D7 — Attach a body photo to a check-in

**Where:** Either, but a real photo from a real camera roll is the point.

**Do:** Open a check-in from the Today or Goals card. Attach a photo. Use a
recent full-resolution one — a Live Photo, a portrait-mode shot, an HEIC.
Then type a weight, attach a photo, and **only then** save.

**Should:** The photo uploads and appears on the check-in. Anything you had
already typed and not yet saved is still there afterwards.

**Failure looks like:** The upload failing on a large or unusual image format.
The typed-but-unsaved weight or note being wiped when the photo lands — that
exact bug has been fixed once already. Note also that **there is no camera
option here at all**, only the photo library; if that reads as broken to you,
that is a finding worth filing.

## Sound, speech and haptics

None of this can be heard or felt in jest, and `components/Countdown.tsx` and
`components/Timer.tsx` both execute **zero statements** under the entire suite.
The timing arithmetic is well covered; the wiring to the speaker is not covered
at all.

### D8 — The rest timer, with the phone silenced and music playing

**Where:** iPhone only — a Simulator has no ringer switch.

**Do:** Start playing music (Spotify, Apple Music, anything). Put the phone on
**silent**. Start a session, finish a set, let the rest timer run out.

**Should:** The chime plays **through the silent switch** — that is deliberate,
a rest timer you cannot hear is not a rest timer. Your music should **duck**
under it and come straight back, never stop.

**Failure looks like:** Silence. Or music that stops dead and has to be manually
restarted. Or a chime so quiet under a loud mix that you miss it. The sound
levels are intentionally uneven between cues (a tap is much quieter than
rest-over) — judge whether that works in a noisy room, because that is the room
it was tuned for and nobody has heard it there.

### D9 — The rest timer across backgrounding and lock

**Where:** Either.

**Do:** Start a rest timer. Switch to another app for longer than the rest
period. Come back. Repeat, but **lock the phone** instead. Repeat again,
backgrounding at the exact moment the timer is about to expire.

**Should:** Coming back shows the correct remaining time, or a completed rest —
once.

**Failure looks like:** The completion firing **twice** — logging a duplicate
set, or skipping the next step of an interval run. This is a known and
specifically-guarded race, and the realistic trigger is precisely this: a
suspended timer and a wake-up handler arriving in the same batch. Also note
there is **no background alarm** — nothing fires while the app is buried. If
you expect a notification during a long rest, there isn't one, by design.

### D10 — Spoken countdown cues

**Do:** Turn voice cues on in Settings. Run an interval workout with music
playing and with a Bluetooth headset connected.

**Should:** Cues are spoken clearly over ducked music, and route to the headset.

**Failure looks like:** Speech that overlaps the chime, that fires after the
step it was announcing, or that keeps talking after you stop the run.

### D11 — Haptics

**Where:** iPhone only. The Simulator has no Taptic Engine.

**Do:** Hold a hold-to-confirm control to completion. Finish a set. Finish a
session. Hit a PR.

**Should:** Distinct, well-timed taps that match what just happened.

**Failure looks like:** Nothing at all, everything feeling identical, or a
buzz that lands noticeably after the thing it is confirming.

## Silent wrongness

### D12 — A grip survives a round trip

**Do:** On the phone, log a set and set its **grip**. Save. Leave the screen,
come back, edit something else about that set — the weight — and save again.
Now open the same session on the **web** app and look at the grip. Then edit
the set on web and look at it on the phone again.

**Should:** The grip is unchanged everywhere, throughout.

**Failure looks like:** The grip quietly becoming "not recorded" after an
unrelated edit. Sets are written back **wholesale**, so any client that does
not know about a field erases it, and nothing errors. This is trap T3/T4 in
`docs/TASKS.md`, and the worst case is the server's own read dropping it — at
which point every correct client faithfully writes the loss back.

### D13 — Airplane mode mid-session

**Do:** Start a session. Log two sets. Turn on **airplane mode**. Log three
more, edit one, delete one. Wait. Turn airplane mode off. Watch the sync chip
in the header. Then force-quit the app before it finishes syncing and reopen it.

**Should:** Everything keeps working offline — nothing spins, nothing claims you
are signed out. When signal returns, everything pushes and the chip goes quiet.
All five sets, the edit and the deletion survive.

**Failure looks like:** *"Not signed in"* appearing across the app the moment
signal drops — the sign-in library returns nothing rather than failing when
offline, and reading that as signed-out is a bug this app has had before. Or the
deletion coming back from the dead. Or the sync chip reading zero pending while
something is genuinely unsent.

### D14 — A gym with bad signal, not no signal

**Do:** Somewhere with one bar, or on a deliberately throttled connection, use
the AI features (D1, D4) and the sync path.

**Should:** Slow, and honest about being slow.

**Failure looks like:** A server that answered badly being reported to you as
*"you are offline"*. Tracked as [#365](https://github.com/dmytro-ch21/formspan/issues/365) (N55) —
worth confirming on hardware whether it still reads that way.

### D15 — Every BJJ surface with the module switched off

**Do:** Turn the BJJ module off in the profile. Walk every BJJ entry point you
can find. Turn it back on.

**Should:** Something explains where they went.

**Failure looks like:** Blank screens and vanished tabs with no explanation —
indistinguishable from the app being broken. Tracked as
[#370](https://github.com/dmytro-ch21/formspan/issues/370) (N61) and already
claimed; listed here because it is the archetype of a failure that is silent by
construction, and because the same shape exists on **web**, where the sidebar
can drop destinations with no error.

## Rendering that has never executed

These 31 mobile routes execute **zero statements** under the entire test suite
(measured, and agreeing with the static analysis). Nothing here is known to be
broken — nothing here is known at all.

### D16 — Walk the untested screens

**Do:** Open each of these and look at it. Rotate the phone. Scroll to the
bottom.

`session/[id]` (the live set editor) · `session/[id]/add` · `session/start` ·
`bjj/index` · `bjj/log` · `bjj/positions` · `bjj/roundmap` · `bjj/reflect/[id]` ·
`bjj/promotion/new` · `bjj/promotion/[id]` · `checkin/[date]` · `checkin/trend` ·
`curriculum/[id]` · `technique/[id]` · `exercise/[id]` · `library` ·
`records/pinned` · `phase/index` · `profile/edit` · `settings` ·
`settings/units` · `food/entry/[id]` · `food/target` · `(tabs)/food` ·
`sign-in` · `sign-up` · `forgot-password` · `+not-found`

**Should:** Each renders, scrolls to its end, and its buttons go somewhere.

**Failure looks like:** Content trapped under the notch or the home indicator.
A screen that cannot scroll far enough to reach its own save button — that
exact bug shipped on the nutrition target screen and was found by an athlete.
Text truncated at two characters. A tap that lands on `+not-found`.

### D17 — VoiceOver on the set editor

**Do:** Turn VoiceOver on. Navigate the set editor end to end — the set pills,
the collapse, the hold-for-info panel, the Timed switch, `+ Set` and `+ Drop`.

**Should:** Every control is reachable and announces what it is and what state
it is in.

**Failure looks like:** Unlabelled buttons announced as "button". State carried
only by colour or by a glyph — icons are explicitly hidden from VoiceOver, so
anything communicated by an icon alone is communicated to nobody.

**This is the last item still open on #380 for a component that is otherwise
confirmed**, and it is the part that component's design leans on hardest.

### D18 — Largest Dynamic Type

**Do:** Settings → Accessibility → Display & Text Size → Larger Text, dragged to
the maximum. Reopen the app and walk the tabs.

**Should:** Everything stays readable and reachable.

**Failure looks like:** Buttons pushed off-screen, labels overlapping, a
floating action button covering the last row of a list. Only two screens in the
whole app do any arithmetic on the text scale.

### D19 — Notch, home indicator and the edges

**Do:** On a phone with a Dynamic Island, look at the top of every tab. Scroll
each list to its very end and look at the bottom.

**Should:** Nothing under the island, nothing under the home indicator.

**Failure looks like:** The wordmark colliding with the island. A last row you
cannot fully read or tap. Only two files in the app read the safe-area insets;
everything else uses fixed padding that was chosen by eye.

### D20 — The keyboard, on every screen that has a text field

**Do:** On each screen with a text input, tap the **last** field on the screen
and type.

**Should:** The field scrolls clear of the keyboard, and the screen's primary
button is still reachable.

**Failure looks like:** The field hidden behind the keyboard. The check that
guards this is honest about its own limit: it proves each screen *imports* the
shared keyboard container, not that the container actually wraps the input.

### D21 — The weight trend chart

**Do:** Log weight on several days across a few weeks. Open the trend from the
check-in card. Try each preset window.

**Should:** You can read actual numbers off it and answer "am I losing weight
fast enough" in about three seconds.

**Failure looks like:** A chart with no numbers on it. The last verdict on this
screen from the person who owns it was **"pretty much useless"** — worth
confirming whether that is still true. It has zero test coverage and zero
accessibility labelling. Rework is tracked as
[#374](https://github.com/dmytro-ch21/formspan/issues/374) (N56).

## Web and admin

**Zero of the 43 web and admin pages has a test that renders it.** Both suites
run in Node with no DOM, so nothing in either app has ever been clicked by
anything. What follows is the short list of places where that is most likely to
bite; the rest is simply unwalked.

### D22 — The N10 grip select

**Do:** In `apps/web`, go to **History**, and open a session that is still
**in progress** — the list marks them "· in progress". Find a set for a lift
with a grip vocabulary (a bench, row, pulldown or deadlift pattern). The grip
picker sits inline in the dense sets table.

**Should:** A select is there, with "Not recorded" plus the grips that lift
actually offers, and changing it sticks.

**Failure looks like:** No select at all — but note **two innocent reasons** it
would legitimately be absent: the session is finished, or that exercise offers
no grips. Confirm both before filing anything. Then cross-check the result
against D12 on the phone.

### D23 — The dashboard sidebar

**Do:** Sign in to `apps/web` and count the destinations in the left rail.

**Should:** All of them are present.

**Failure looks like:** One or two quietly missing. The nav filters itself on
module state inside a `try/catch`, so a partial or failed module lookup **drops
destinations with no error**, and a missing item is indistinguishable from an
intentionally gated one.

### D24 — The two untested charts

**Do:** Open `/dashboard/records` (load history) and `/dashboard/library/map`
(the round map). Compare a number on each against the same number elsewhere in
the app.

**Should:** They agree.

**Failure looks like:** A plausible chart that is wrong — an inverted axis, a
bad scale, an off-by-one path. Both are 450+ lines of SVG with no test on the
rendered output, and a chart that renders cleanly reads as a fact.

### D25 — The admin content write path

**Do:** In `apps/admin`, create a technique, edit it, publish it, then restore
an earlier revision. Repeat for an exercise. Search for something, then use
**Clear**.

**Should:** Each step does what it says, and the search box empties when cleared.

**Failure looks like:** A restore that blanks a field rather than restoring it —
**adding a column to the exercise update path has silently blanked data three
times**, and the revision log then records the wipe as legitimate history. Also
watch for a search box still showing a query it has already cleared, and for
"Nothing matches" appearing when the real problem is a failed request.

---

## What is deliberately not here

- **Anything a fixture test already exercises against real SQLite.** The sync,
  tombstone and outbox behaviour is covered by tests that run the app's own
  migrations against a real database engine. Re-checking that by hand is not
  where the risk is.
- **Pure arithmetic** — set transforms, 1RM, macro maths, the countdown
  schedule. All covered, and a phone tells you nothing a test doesn't.
- **Anything already open as its own issue with a reproduction.** Where an item
  above overlaps one, it is cross-referenced rather than restated.

## When something fails

File it as its own issue with a screenshot, the build it came from, and the
phone and OS version. Do not fix it during the session. Then strike the
corresponding line on [#380](https://github.com/dmytro-ch21/formspan/issues/380)
for anything you confirmed **good** — that list is meant to shrink from both
ends.
