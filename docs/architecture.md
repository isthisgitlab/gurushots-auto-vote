# Architecture & invariants (developer reference)

This is the deep reference behind the terse invariant bullets in `CLAUDE.md` / `AGENTS.md`. It documents
the application's own conventions — the voting engine, scheduler, API transport, IPC surface, persistence,
renderer, i18n, and security — the things a contributor (human or agent) must not break but that the code
alone doesn't spell out. For the three per-platform timer engines, see the companion `scheduling.md`.

**Citation convention.** Each reference names the **symbol/function** and its file, and carries no line
numbers: this repo has high edit velocity and line ranges rot on the next unrelated edit. Search by name.

**Path convention.** Paths are relative to `src/ts/`; renderer paths keep their `react/…` segments
(e.g. `react/components/ui/Modal.tsx`).

---

## Glossary

Domain terms used throughout, in reader's terms:

- **exposure factor** — how much the GuruShots API has shown your photo in a challenge, 0–100%.
- **trigger** — vote _if_ current exposure is below this value.
- **target** — vote _up to_ this value (the vote loop's ceiling). Distinct from the trigger.
- **auto-fill** — automatically submit new photo entries into a challenge's open slots. User-facing text
  calls this **Auto-Submit** (and `emergencySubmit` **Emergency Submit**): to GuruShots players a **fill** is the
  currency that tops exposure up to 100% (`autoExposureFill`, the `fills` balance), so the UI, CLI and README
  reserve "fill" for that.
- **boost** — a one-shot exposure multiplier applied to a single entry.
- **turbo** — a timed exposure surge on an entry.
- **flash** — a challenge _type_ that is always auto-targeted to 100%.
- **last-minute / final-window windows** — deadline-proximity windows that change both the cadence and the
  exposure targets.
- **key-unlock** — a boost unlocked by spending a challenge key.
- **emergency window** — a near-deadline override that spends an otherwise-idle boost/turbo/fill so it
  isn't wasted at the buzzer.

---

## 1. Voting decision engine

- `runVotingPass(token, filter, deps)` (`services/votingOrchestrator.ts`; its per-phase runners live in `services/votingOrchestrator/`) is the **one**
  shared loop for both real and mock strategies. **Never fork it** — a fork re-introduces the real/mock
  drift the shared loop exists to remove. Inject strategy differences via `deps`.
- The per-challenge action **runners are strictly sequential, never parallelised**: auto-fill mutates the
  shared challenge object (`reflectNewEntry`) so a later turbo/boost in the same cycle sees the new entry
  and the consumed slot.
- The decision engine is `_runVotingRules()` (`services/decisions/ruleEngine.ts`). Its precedence
  order is load-bearing: onlyBoost → not-started / already-ended → flash (→100) → last-minute window
  (→100) → **pre-boost fill** (→100) → **voting pause** → scheduled-fill window → **pre-final-window top-up** →
  final-window rule → normal threshold. The **pre-boost fill** (`voteBeforeBoost`, default off) votes to
  **100%** for `voteBeforeBoostLeadMin` (1–59, default 15) minutes before an available Boost is auto-applied,
  so the Boost multiplies a full entry rather than a decayed one — a Boost is one per challenge and is spent
  on whatever the entry has at that instant. The apply instant is not re-derived: it comes from the same
  `boostApplyThreshold` (`voting/boostWindow.ts`) that `getBoostThresholdSec` uses, so the fill can never aim
  at a moment the boost runner disagrees with. `getBoostPrefillState` gates it on the opt-in, `autoBoost`, a
  genuinely AVAILABLE boost, and the `0 = off` sentinel on whichever window the branch measures against
  (`boostTime` for a timer boost, `keyUnlockedBoostTime` for a key-unlocked one) — `boostApplyThreshold`
  deliberately does not apply that sentinel itself, so `orderDeadlineActions` keeps sorting on a pure function
  of the settings. It sits **above** the voting pause for the same reason flash/last-minute do: the Boost is
  spent on the challenge's schedule whatever the pause says, so a pause swallowing the fill would not defer a
  cost but permanently waste the Boost. Auto only. Deliberately NOT gated on the boost/turbo conflict — unlike
  a wasted Boost, the exposure bought still counts either way. The **voting pause** (`useVotingPause`) is the inverse of scheduled fill — an opt-in
  window in which automatic voting is _refused_, for the overnight gap between match rounds where filled
  exposure earns almost no votes. Same two trigger lists (`votingPauseTime` daily 'HH:MM' starts +
  `votingPauseBeforeEnd` seconds-before-close starts), each lasting `votingPauseDurationMinutes`, all OR'd.
  It sits **below** flash/last-minute deliberately — a challenge that genuinely closes mid-pause must still
  get its final fill, since a lost placement is permanent while a skipped night top-up only defers votes —
  and **above** scheduled fill and all three threshold rules, which are exactly the discretionary exposure
  maintenance it exists to defer. It sits **below** the pre-boost fill for the reason given above. Auto only (manual voting is never refused); boost/turbo are untouched
  because they run on the orchestrator's own path ahead of this and their timers expire on the
  challenge's schedule. The
  pre-final-window top-up (`voteBeforeFinalWindow`) votes to the **standard** exposure target inside a window
  straddling the final-window boundary — `[close − finalWindowDuration − lead, close − finalWindowDuration + lead]`, `lead` =
  `voteBeforeFinalWindowLeadMin` (1–59, default 15) — so a challenge whose exposure already decayed below
  the standard target is not stranded there by the lower final-window trigger. It sits **above** final-window
  (it must win while both windows overlap in the lead minutes after the boundary) and **below**
  scheduled-fill and last-minute (those still force 100). Only active when `useFinalWindowExposure` is on.
- **Trigger ≠ target, and there are two _different_ sentinel families — do not merge them:**
    - `exposureTarget` / `finalWindowExposureTarget`: `0` or null means **"target == trigger"** — the rule
      stays **active**, it simply votes up to the trigger value.
      `getEffectiveExposureTarget()` (`services/decisions/thresholds.ts`); schema note in
      the `exposureTarget` entry comment in `settings/schema/general.ts`.
    - `boostTime` / `emergencySubmit` / `keyUnlockedBoostTime`: `0` means **feature off / never auto-apply**.
      See the explicit comment in `getEffectiveKeyUnlockedBoostTime()` (`services/decisions/thresholds.ts`:
      _"An explicit 0 means 'never auto-apply', matching the 0-is-off convention boostTime and
      emergencySubmit already use"_), and `maybeEmergencyFillChallenge()` (`services/autoFill/emergencyFill.ts`:
      `emergencySeconds <= 0` → `'disabled'`).
- Magic constants: final-window width defaults to 3600 s — the `finalWindowDuration` setting's default
  (configurable 60 s … 30 d); key-unlock boost default window = 900 s when the setting is
  unusable (explicit `0` still = never).
- Vote submission votes over a **Fisher-Yates-shuffled, de-duplicated** pool (structural termination — rejection
  sampling could loop forever on duplicate ids) and never posts an empty ballot
  (`api/voting.ts`).
- **≤1 boost and ≤1 turbo per challenge, on different entries** — enforced by `pickEntryAvoidingConflict()`
  (`services/decisions/entryPick.ts`) plus a `reflectEntryFlag` marker. Entry-pick logic lives in
  the shared decision core (behind the `VotingLogic` facade) rather than in `api/boost.ts` so mock mode honours the same rule.
- **Sleep boost** (`runSuspendBoost` / `runSuspendBoosts` in `services/votingOrchestrator/boost.ts`, driven by
  `windows/suspendBoost.ts` on `powerMonitor` `'suspend'`): not a fork of the pass — it reuses `runBoost`'s target
  resolution, uncertain-photo skip and turboed-only skip, and is reached through the strategy's
  `applyBoostsOnSuspend` binder (real in `strategies/real/index.ts`, mock in `mock/strategy.ts`) exactly as
  `runVotingPass` is reached through `deps`. It never submits a new photo and overrides a fresh-entry hold instead of
  honouring it. It is the **one deliberate exception to the sequential-runner rule**: `runSuspendBoosts` runs the
  selected challenges in parallel (`Promise.allSettled`), because they are separate challenge objects with no shared
  mutation (there is no auto-fill here to reflect a new entry) and the device is about to lose the network, so
  the 2–5 s inter-challenge delay is not affordable. The quit guard (`windows/quitGuard.ts`) and the sleep boost
  pick their challenges with the same `imminentBoostChallenges`, differing only in horizon (60 min vs 30 min).

## 2. Scheduling

- `createCadenceChain()` (`scheduling/cadenceChain/chain.ts`) is a single recursive `setTimeout`
  chain — **no cron** — shared by the CLI (`scheduling/runScheduler.ts`) and the GUI
  (`react/contexts/AutovoteContext.tsx`). The Android headless service (`headless/index.ts`) has no chain: the
  native service's `AlarmManager` ticks, each tick runs one cycle, and the next delay comes from
  `computeNextCycleDelayMs()` below. See `scheduling.md` for the three timer engines per platform.
- The single cadence decision is `computeNextCycleDelayMs()` (`scheduling/thresholdWindow/cadenceDecision.ts`): modes `last-minute` / `approaching` / `scheduled` / `normal`, with the invariant **never sleep
  past an upcoming boundary**.
- Double-fire guard: a **stale-timer identity check** (`getTimer() !== timeoutId`) ensures only the
  current timer re-arms, so a re-armed/stopped chain can't double-fire. There is no mutex around a
  _running_ cycle — safety comes from the single-chain design plus the cancellation flag.
- Cancellation is a **global singleton flag** (`voting/cancellation.ts`) checked at multiple checkpoints in
  the pass, and it propagates by **`return`, never `throw`** — precisely so a per-challenge try/catch can't
  swallow it.
- `now` is re-read per challenge (a pass can take minutes, so a single clock would miss windows that open
  mid-pass).
- **Auto-join is a pre-step of the pass, not a separate schedule.** `runJoinPass` (`services/joinChallenges/joinPass.ts`)
  runs inside the shared `fetchChallengesAndVote` (`strategies/real/index.ts` real / `mock/strategy.ts` mock) before the
  voting pass, so all three platforms get it without forking `runVotingPass`. It is skipped for a
  single-challenge run and never allowed to abort voting (its errors are caught and logged). The `autoJoin`
  enable is **resolved per candidate by rule (see challenge rules below) → master**, not a hard global gate —
  the master value is only the default, so a rule can enable joining for the challenges it matches with the
  master off, either inline on the rule itself or through the named profile it inherits. The pass only
  short-circuits wholesale when the master is off **and** no rule turns it on (a rule that only adds photo
  tags never does); everything else (scope/coin caps/join window) is rule-resolved too, except
  `autoJoinCycleCoinBudget`, which is genuinely pass-global.
- **The join window gates WHEN, never WHETHER.** Two settings express it, both on the `0` = off sentinel:
  `autoJoinWithinHoursOfEnd` joins a candidate once it is within that many hours of its own `close_time`,
  and `autoJoinAfterPercentElapsed` joins it once that percentage of its own lifetime
  (`close_time` - `start_time`) has run. Outside the window the candidate is _deferred_
  (`skipped:too-early`) and reconsidered next cycle, not rejected. It is **fail-closed**: a candidate whose
  `close_time` cannot be read is not joined while a window is set (percent mode additionally needs
  `start_time`, and reports `skipped:start-time-unknown`), and the pass logs that candidate's actual field
  names once per pass. Unlike the type filters, a rule opt-in does **not** bypass the window (bypassing an
  explicit "join late" would invert it), and the manual single-join path ignores the window entirely — a
  click is the user overriding timing.
- **Percent and hours never combine — `resolveJoinWindow` picks exactly ONE.** Percent wins whenever it is
  above 0, so a rule saying "90%" fully _replaces_ an inherited hours window instead of
  intersecting with it; the effective timing for a candidate is therefore always readable off a single
  number. The reason percent exists at all: hours-before-close does not transfer across challenge lengths.
  The live open list carries 2h flash challenges and 515.7h exhibitions side by side, so one absolute window
  is either far too late for the short ones or far too early for the long ones, while `75` means the same
  thing to both. The percent ceiling is **99, not 100**: a challenge is only 100% elapsed once `close_time`
  has passed, at which point the gate already reports `already-closed` — allowing 100 would ship a maximum
  that silently never joins. Out-of-range values clamp to 99 (as late as possible), never to "never".
- **Challenge rules match on conditions; the LIST ORDER is the precedence.** A rule in
  `challengeSettings.titleRules` carries any mix of conditions — titles (one `match` mode for all of them:
  `exact`, the default, `starts`, or `contains`), `challengeTag`, `type`, `pics` (`max_photo_submits`) and a
  runtime range `minHours`/`maxHours` over `close_time` - `start_time`, and close times (strict `HH:MM`, any
  date) — and every condition present must hold (AND); a rule with none matches nothing, and a runtime
  condition fails closed when either time is unreadable. The close times are `closesAt`, the first, and
  `closesAtTimes`, written only when there are two or more (at most 24; a repeat or blank entry is dropped on
  save). One normalizer, `normalizeRuleCloseTimes`, reads both into `RuleConditions.closeTimes`: a non-empty
  `closesAtTimes` wins over `closesAt`, and an empty list (or one of blanks) falls back to it; the rule matches
  when the challenge closes at **any** of them. A close time compares against the end time the
  challenge card shows: `close_time` read in the app's `timezone` setting (`timeOfDayIn` in
  `scheduling/wallClock.ts`; `'local'` and an unknown zone read the device clock, like `formatEndTime`),
  minute floored. It fails closed both ways: an unreadable `close_time` matches nothing, and a stored
  `closesAt` or `closesAtTimes` that is present but malformed (a list that is not an array, a non-text entry,
  or a non-blank entry that is not strict `HH:MM`; hand-edited) makes the rule match nothing and is not
  counted as a condition (the sanitizer rejects it on save) — so a skip rule keyed on it falls through to
  global auto-join when a payload lacks `close_time`. The matcher formats the close time only when some rule
  carries valid close times. The pure matcher and the default order live in the dependency-free
  `settings/challengeRules.ts` so the renderer can use them too. Runtime exists because entry timing and
  tactics really track how long a challenge runs, and photo count is only an **imperfect proxy** for it: on
  the live account 4-photo defaults run 24h, 2-photo ones 48h and 3-photo ones 72h, yet 4-photo challenges
  also span 72h, 168h and 515.7h — so "4 photos" and "4 photos + at least 168h" are different rules.
- **Resolution cascades per key (`ruleValuesFor` in `settings/ruleResolution.ts`).** The matching rules are walked in list order and, for
  each setting, the FIRST rule that sets it wins — its own inline value first, then (for the first rule
  naming a profile only) that profile's value; a key it leaves unset falls through to the next matching
  rule, then to the global default. Only **one profile** ever applies to a challenge, because profiles are
  validated as a whole value set (cross-field rules like `exposureTarget >= exposure`) and mixing keys from
  two could assemble a combination neither allows. An omitted key at any tier means _inherit_ and is never
  written as a value, so no rule can freeze today's default into storage. Id-keyed callers
  (`getEffectiveSetting`) resolve the same cascade through the in-memory facts cache
  (`rememberChallengeTitles`: tags, type, photo count, start/close time per id), below any per-challenge
  manual override; the join pass resolves un-joined candidates off their own payload
  (`resolveRuleSetting`).
- **Default order: a title beats a class.** `sortRulesByDefaultOrder` ranks rules naming a title first
  (exact 3 > starts 2 > contains 1, +1 per class condition, then the longer pattern — the specificity ranking title rules were written against), then title-less rules
  by condition count, then photo count > runtime > close time > type > tag — so "4 photos + 7 days" > "4 photos" >
  "7 days". A close-time-only rule has no title and one condition, so sorting demotes it below every title rule,
  every title-less rule with more conditions, and any one-condition rule with a photo count or a runtime —
  where a rule with `autoJoin: true` wins over its skip; the editor warns next to the Sort button. The user can reorder freely in the editor or reset to this order; saving keeps the order given.
  The one-time `_challengeRulesOrderedV1` migration applies this order to saved rules and appends the saved
  `categoryRules` below them; because the cascade lets a lower rule fill keys a higher one leaves unset, it
  logs a warning for every possibly-overlapping pair where that could newly switch `autoJoin`/`autoSubmit` on.
  Rules de-duplicate on the whole condition (last wins, at the first one's position), so `abc`/exact and
  `abc`/contains coexist.
- **A title-less rule may switch joining or auto-submit ON** for everything it matches; the editor warns
  when one does, since a single row can then spend coins/photos across a whole class of challenges. It does
  **not** bypass the join type filters through a profile alone (`hasRuleJoinOptIn`): only an explicit
  resolved `autoJoin: true`, or a profile from a rule naming a title or challenge tag, does — "every
  4-photo challenge votes like this" says how, not whether.
- **Challenge tags ≠ photo tags — the two must not be conflated.** `mustIncludeTags`/`shouldIncludeTags`
  choose which of the user's PHOTOS to submit; a rule's `challengeTag` and the `autoJoinChallengeTags` /
  `autoJoinExcludeChallengeTags` settings choose which CHALLENGES to act on, from the API's own classifiers
  (`Exhibition`, `Comm`, `No comm`, `Turbo`, `Magazine`, `special 4 pic`, `N photos`, `MV`, `Strong`).
  The join-scope lists mirror the type lists exactly (empty include = all, exclude subtracts, a rule opt-in
  bypasses both), and types and tags are independent axes that must BOTH pass.
- **Tag resolution for id-keyed callers** rides an in-memory `activeChallengeTags` map filled by
  `rememberChallengeTitles` alongside the title cache — deliberately NOT the persisted `titlePins` blob,
  which exists to defeat a mid-challenge server-side rename and would only grow. Joined challenges carry
  `tags` too (verified 18/18), so a tag-keyed rule drives auto-fill and per-challenge settings, not just
  auto-join.
- **`get_member_challenges('open')` payload (verified against live 2026-09-19, 12/12 items).** Every open
  challenge carries `close_time` **and** `start_time` as epoch seconds, so the join window rests on a field
  that is actually there and a percent-elapsed anchor is implementable if ever wanted. Also present on every
  item: `id`, `title`, `type`, `url`, `join_coins`, `tags`, `entries`, `players`, `max_photo_submits`,
  `member`, `time_left`, and the `*_enable` capability flags (`boost_enable`, `turbo_enable`, `swap_enable`,
  `fill_enable`, …). The fail-closed branch above therefore guards against the field going away upstream,
  not against the normal case. Note `getMemberChallenges` returns `[]` for **both** an empty list and an auth
  rejection (`{success:false, error_code:1000}` has no `items` array), so an expired token makes the join
  pass look like an idle account.

## 3. GuruShots API transport

- **Layering**: `api/` is the transport layer — `api-client.ts` plus one thin wrapper per endpoint, importing
  nothing from `services/` (`api/voting.ts` still records vote timestamps in `metadata.ts`). The real-mode strategy composes those wrappers with the services in
  `strategies/real/`: `index.ts` (`fetchChallengesAndVote` with its mission read (`services/missions.ts`) and join/claim pre-steps, manual join, the
  Turbo mini-game), `applyBoost.ts` (picks the entry via `pickBoostEntry`, posts it through
  `api/boost.ts#boostImage`, flags it `boosted`) and `activeChallenges.ts` (coalesces concurrent
  `getActiveChallenges` calls per token and pins first-seen titles via `services/challengeTitlePin.ts` on a
  successful fetch only). `apiFactory.ts` assembles the real surface from these and selects it or
  `mock/index.ts#mockApiClient`.
- **Turbo games**: which game a turbo is — `member.turbo.mode`, `'classic'` or `'snap'` — comes only from the web
  read overlaid in `strategies/real/activeChallenges.ts`; a turbo without a mode is unknown and is never played,
  nor is its WON trusted (`isKnownTurboMode`, `voting/turboMode.ts`). `runTurboGame` (`strategies/real/index.ts`)
  dispatches on the mode: classic runs the battle loop over `get_challenge_turbo` exactly as before, Snap
  (`strategies/real/snapGame.ts`) opens `start_turbo_session` and answers each photo with `submit_snap_vote`,
  yes or no by the local vision model (`judgeSnapImage`), paced at 3–6 s a photo; the tenth answer wins, and a
  reopened session resumes at the server's `position`. A Snap is **never** played as classic —
  `get_challenge_turbo` on a Snap challenge makes the server swap a classic game in — and an answer is sent
  once, an unclear one never resent. The automatic pass plays one Snap game per pass (a game that landed an
  answer, or may have, takes the slot), and none in the Android headless service (its cycle is capped at
  120 s). A Snap that turns out not playable — withdrawn, an unreadable question, a dead session, an answer the
  server refused, or three transient failures in a row — is remembered in-process (`markSnapUnavailable`, `services/turboRunLock.ts`), and
  `shouldPlayAutoTurbo` leaves that challenge's turbo alone in any mode; a manual run ignores the marker. Without
  the vision model Snap stops `no-model` before any request and marks nothing, unless `snapYesWithoutModel` is on: then
  every photo is answered yes (no judging, and the question need not parse), at the same pace.
- Every POST goes through `api/api-client.ts`. `makePostRequest<T>()`, used by every request but a spend, has this
  **contract: it returns the response body as `T` on success and `null` on ultimate failure or when the body is
  not a JSON object — it never throws.** Every caller branches on `null`, not on a catch. Only the object check
  is enforced: `T` declares every field optional and each endpoint wrapper guards its reads (a tolerant reader —
  a strict schema would turn harmless upstream drift into a failed request).
- **Spends are the exception.** `coins_unlock` (`api/join.ts`) and the currency spends (`api/currency.ts`) go
  through `postOnce` (`api/api-client.ts`, `api/postOutcome.ts`): sent once, never repeated, and answered as a
  `PostOutcome` — `body`, `refused` or `unclear` — instead of `null` (see §5).
- Auth: `authenticate(email, password)` posts form-encoded credentials and returns the token payload
  (`api/login.ts`). The token is then threaded **explicitly** from caller to caller and injected as the
  `x-token` header — there is no refresh flow.
- Token flow: the `authenticate` handler stores the token in the settings store and returns only
  `{ success }`; the token lives only in the main process / that store. A renderer sees `RendererSettings`
  (`types/settings.ts`): the settings without `token`, plus `hasToken`, built by `toRendererSettings`
  (`ipc/rendererSettings.ts`) for `get-settings` and every `settings-changed` broadcast (including the file
  watcher's). `get-setting` returns nothing for `token`/`hasToken`, `set-setting` refuses and `save-settings`
  drops those keys, and `get-active-challenges` reads the token in main (no token → the failed-fetch list
  shape). On Capacitor the renderer shares the JS realm with the handlers, so this is consistency, not a
  security boundary there.
- Retry/backoff is centralised: exponential backoff + jitter up to `apiMaxRetries` (default 3). Retryable =
  no-response/network, `ECONNABORTED` timeout, 429, any 5xx; every other 4xx is terminal. Honors a server
  `retry_after` / `Retry-After` (seconds). `MAX_RETRY_DELAY_MS = 30000` — a longer server cooldown returns
  `null` and is deferred to the next scheduler cycle.
- Custom (Android OkHttp) adapters **must** call `finalizeAdapterResponse()` to reject non-2xx — axios
  doesn't post-process adapter results, so otherwise an error body is handed back as "success."
- `fetchFailed` vs empty: `getActiveChallenges` distinguishes an outage from an empty account so the
  scheduler doesn't re-arm as if all is well (`services/votingOrchestrator.ts`).
- Join/bankroll endpoints (`api/join.ts`, WEB profile): `get_member_challenges` (open/un-joined list),
  `coins_unlock` (spends coins to open a paid challenge — **not** known to be idempotent), `get_bankroll`.
  `getBankroll` normalizes the currency array to `{keys,swaps,fills,coins}` and returns **`null` on failure
  — callers must distinguish that from a genuine zero balance** (the UI renders `—`, the handler returns
  `success:false`). Every dynamic value is `encodeURIComponent`'d into the form body.

### 3a. Reading a challenge title

A title rarely just names its subject, so three rules turn it into something searchable
(`services/photoPicker/title.ts`):

- **Series prefix.** `"Color Hunt: Green"` is about green, not colour or hunting. Everything before a
  `:` / en dash / em dash is the series name, so the subject is what follows. A plain hyphen is NOT a
  separator — it appears inside ordinary titles too often to treat as structure. Falls back to the whole
  title when the tail has no usable word.
- **Theme trusts the title over the slug.** `buildThemeKeywords` reads url only when the title yields
  nothing. The two normally agree, but a series slug is **recycled**: the live `"Color Hunt: Green"` ships
  `url="color-hunt-blue1"`, so pooling both put the WRONG colour in a green challenge's theme.
  `buildChallengeKeywords` (the lexical tier) still keeps the whole title and url — there each keyword is
  matched independently, so extra words are weak evidence rather than vector noise, and it is the safety
  net for a title whose subject sits before the separator.
- **Head noun first, participles last.** Search terms are capped at `SEARCH_TERMS_CAP`, so ORDER decides
  what survives: `"Color Hunt: Blue & Orange"` read left-to-right would yield `[color, hunt, blue]` and
  drop "orange" entirely. An English title puts its subject last (`"Epic Lighthouses"`), so nouns are read
  right-to-left — except participles (`-ing`, length-guarded so "king"/"ring" are not caught), which sink
  to the back because the subject LEADS in `"Cats and Dogs Running"`.

The user-editable `ignoreTitleWords` setting (master → profile → per-challenge) strips qualifiers the
rules cannot know are noise — "Epic", "Dramatic", "Captivating". Matched against the RAW word before
stemming, like `STOPWORDS`, so a user writing "captivating" does not have to know it stems to "captivat".
The default is **seeded, not hardcoded**, so every word is visible and removable; "negative" is
deliberately absent because "Negative Space" is a real subject. It is resolved ONCE in `loadFillCandidates`
(`services/autoFill/pipeline/scoring.ts`; and once in `pickJoinPhoto`) rather than threaded from the six sites that read the tag settings — a value
repeated six times is one that gets forgotten at one of them.

### 3b. Tag resolution (auto-fill candidate narrowing)

- **The two search endpoints match differently, and that asymmetry is the whole feature.**
  `get_photos_private?search=` matches a library tag **EXACTLY** (`staircase` → 23 photos, `stair` → 0,
  `stairs` → 0), while `search_autocomplete` matches a **SUBSTRING** of a tag (`stair` → `["staircase"]`,
  `case` → `["staircase"]`, and `stairs` → `[]` because no tag _contains_ it).
- Consequence: a "Stairs" challenge stems to `stair`, the exact search misses, and
  auto-fill falls back to an unfiltered library walk ranked by popularity — an off-theme submission with no
  explanation. `services/tagResolver.ts` runs the miss path's terms through autocomplete to recover the real
  tag. **It only runs after the exact search has already failed**, so a fill that works today pays nothing.
- `search_autocomplete` needs `member_id`, which is a member identity — the account's `user_name` or its
  opaque id hash. **An email is rejected** (`Couldn't find username`), and the app logs in with one, so the
  login field is not a usable source: identity comes from `get_current_member_profile` (token-only) and is
  memoised per token in `services/autoFill/memberIdentity.ts`.
- Resolution is guarded twice because substring matching is blunt: **bounded backoff** (a missing term is
  retried at most `MAX_BACKOFF_STEPS` shorter, never below the server's own 3-char floor) and **mandatory
  validation** — a candidate is kept only if it is a lexical match for the term or the lexicon puts it on
  theme. Without the second guard, `fac` → `["face","factory","manufacturing"]` would fill a "Faces"
  challenge from a factory photo.
- Both deps are **optional** in `fetchCandidatesForChallenge`; omit either and behavior is exactly the
  pre-resolution fallback. Nothing here can fail a fill. **That optionality is a safety net, not the
  shipping state** — every real path supplies them: `strategies/real/index.ts` (the `api:` bundle `buildFillDeps`
  in `services/votingOrchestrator/context.ts` copies into `fillDeps`, and `joinDeps`), `ipc/actions/entries.ts` (manual Fill Now), and both mock
  bundles. Note `loadFillCandidates` (`services/autoFill/pipeline/scoring.ts`) rebuilds a fresh deps object for its
  `fetchCandidatesForChallenge` call rather than spreading `deps`, so a dep added upstream must be named
  there too or it is silently dropped for auto-fill, emergency fill and manual fill alike.

### 3c. Chosen photos

`chosenPhotos` (a list of photo ids, `'photos'` setting type, cap `MAX_CHOSEN_PHOTOS` in the dependency-free `settings/limits.ts`) and `chosenPhotosOnly` are ordinary per-challenge settings, also **rule inline keys**: an array-valued inline key where `''` inherits and an explicit `[]` means "no chosen photos". The ids only **filter** the server's own eligible list — a chosen id is never sent to the API on its own, and a chosen photo must come back from `get_photos_private` with `permission.allowed` to be entered.

- **Resolution.** `runFillAttempt` resolves both from `deps.settings` (as `resolveIgnoreWords` does) and passes them down — **not** into `loadFillCandidates`, which swap's `rankCandidatesForChallenge` shares, so swap's ranking is identical with the settings set. `pickJoinPhoto` resolves them itself through `resolveJoinSetting`, which reads the candidate's **per-id override** for these two keys only (an un-joined challenge has no cached id for `getEffectiveSetting`; the Discover panel saves its list per id), then the rules and the global default as for every join key.
- **Cleanup exception.** `cleanupStaleChallengeSetting` prunes as before except that it keeps a non-active entry holding a chosen key while its id is in the most recent open list (`settings/openChallenges.ts`, cached in the main process whenever the join pass or Discover fetches it). An empty open fetch is never remembered as a list, so the previous list (or none) stays. While no list is known (after a restart, or a failed fetch) the entry is kept whether or not auto-join is on, because a manual Discover Join reads the per-id list too; once a list is known, ids that are neither active nor open nor upcoming are pruned (see **Discover sources**). The `cleanup-stale-challenge-setting` handler validates its argument (an array of ids) before pruning. Explicit chosen keys are stored per challenge even when they equal the inherited value (`JOIN_KEPT_KEYS`) while that challenge is not active, because a rule cannot be resolved by id for an un-joined challenge; a joined challenge keeps the normal "equal to inherited means no override".
- **Blocks.** `buildScoredCandidates` runs over the whole pool first, so the hard filters and the `submitWithoutTagMatch` relaxation apply to chosen photos like any other (under Only, the relaxation is judged on the chosen set alone, so whether a chosen photo is used never depends on unrelated photos). Already-entered ids leave the pool as a set. The pool then splits into a **chosen block** and a **rest block**; the pick takes the chosen block first, ordered by the existing tiers, then tops up from the rest. Emergency truncation keeps the head of the list, which is the chosen block.
- **Per-block enrichment.** `selectBlockEnrichmentSet` enriches the candidates still competing for each block's last slot: `selectEnrichmentSet(chosen, min(k, want)) ∪ selectEnrichmentSet(rest, want − k)`. A block that fills no slot (`want − k = 0`) enriches nothing. Block membership (`chosenIds`) is returned so `finalizePick`, `verifyFillPick` and the pick logging use it.
- **Block-bounded visual re-rank.** The re-rank reorders only **within** a block — a chosen photo is never swapped for a top-up photo or the reverse — and is skipped for a _chosen_ block no larger than the slots it fills (the rest block re-ranks as it always did, and an empty chosen set reads exactly like no list). For a join, a usable chosen block is the whole shortlist.
- **Missing chosen ids and the walk memo.** The themed fetch may not return a chosen photo. When usable chosen photos number fewer than `min(unentered chosen, want)`, one targeted library walk runs (never when the fetch already walked unfiltered, never on the emergency path) and merges in only the matching chosen records. `getEligiblePhotos` has a variant returning `{ items, truncated }`: an id is recorded "not found" only when the walk was complete. Outcomes ("found" / "found but refused" / "not found") are memoised across passes per challenge, per usage (submit, or a swap's: the server filters `allowed` per usage, so the swap picker's Auto keeps its own memo) and per photo id (`services/autoFill/chosenPhotos.ts`) for about 30 minutes; a changed entry count drops only the negative outcomes, so a photo already found stays found (and the emergency probe still sees it after another chosen photo was submitted). A submit the server answered with `success: false` marks as refused only the submitted ids the memo had found; a submit that threw or got no answer teaches nothing, so those ids go back to unresolved (no backoff). A walk cut short, or one that throws, leaves its unresolved ids waiting with an exponential backoff per challenge (5, 10, 20, 40, then 60 minutes) so the walk does not repeat every cycle; the wait covers only the ids it was set for, so a newly chosen id is looked up at once. When every chosen id is already an entry, the chosen tier is skipped before any fetch (Only off) or the challenge skips (Only on).
- **Only, and its exemptions.** Under Only with no usable chosen photo a challenge is skipped, with one log line per state change. Manual join and `+1`/`+N` (the flag comes from the fill label or the manual-join call site, never from IPC), Emergency Submit (`probeStandDown` and `evaluateEmergencyFill` read the same options, so the deadline view, quit guard and sleep boost agree with the runner) and a paid join that already unlocked (`performJoin` reads `isUnlocked` **before** picking and passes `ignoreChosenOnly`, so coins are never stranded) all ignore it. The automatic swap ignores both settings; the swap picker's Auto ranks with Chosen Photos (they rank first) but never enforces Submit Only. A chosen photo is never recorded as "uncertain" by `recordUncertainSubmission`, so automatic Boost/Turbo don't skip it.
- **Member scope.** The internal `chosenPhotosMemberId` is stamped by the settings IPC (`ipc/chosenPhotosOwner.ts`) whenever a write carries a non-empty list and the signed-in member is known. The CLI records the owner through the same function after `set-setting` / `set-global-default` saves a list, resolving the member with `resolveMemberId` (an unresolvable member leaves the record alone). It checks first, before the write, and only for a value the schema accepts: when lists saved under another account will apply to this account too once the list is saved, it warns then, saying that `clear-chosen-photos` also removes the list being set, so set it again afterwards. When the logged-in member differs, both settings are ignored with one log line per pair. Nothing is deleted automatically: `clear-chosen-photos` (the `clear-chosen-photos` IPC, the chooser's confirmed button, `settings/chosenPhotosClear.ts`) removes only `chosenPhotos` from every layer — global, per challenge, rule inline, profiles, scenario phases — and clears the owner record; `chosenPhotosOnly` stays. The renderer builds a chosen photo's thumbnail from the owner id only after the library listing has shown that the owner is the signed-in account.
- **Scenarios.** A phase's settings overlay sits above every layer, but an un-joined challenge has no scenario state, so a scenario's list applies only to fills after the join. `exportScenarioWithNotes` strips `chosenPhotos` (GUI and CLI share it) and reports what it left out; the import preview's `flagged` lists both keys.
- **Discover rows.** `get-member-challenges` annotates each open item with `chosenOwn` (its own per-id list) and `chosenEffectiveCount` (resolved with `resolveJoinSetting`, the join's own resolution; 0 under another account's list), so a row shows a list that reaches it through a rule or the global default as "Inherited". Under another account's list `chosenOwn` is `[]` (the ids are never sent) with the real `chosenOwnCount`. `get-open-chosen-annotations(ids)` answers the same shape from the settings, so the rows follow a settings change (the settings-changed broadcast, a save in the chooser, a removal) without fetching the challenge list again. Both handlers use the member a cached lookup already resolved (`peekMemberId`) and resolve it (`resolveMemberId`, one identity lookup per token, retried at most every 60 s after a failure) only when none has, such as on a fresh launch; while the member is unknown the ids stay withheld. A chooser opened on a withheld list reads it again once its listing shows the list is this account's (`reloadSaved`), and holds Save, tiles inert, until it has; if the account can't be confirmed it says so and offers Retry. That Retry calls `confirm-account` (no arguments): it evicts the cached failed identity lookup for the signed-in token (a resolved id or a lookup in flight is left alone) and resolves the member again — one profile request, no library walk — answering `{ success: true, memberId }`, `{ success: false, error: 'account-check-failed' }`, or `{ success: false, error: 'not-logged-in' }` (no session: the chooser says to log in again and offers no Retry). A failure younger than 5 s is answered from the cache, so presses repeated within that gap make one profile request. The chooser puts that member into the listing already on screen and then re-runs the saved-list read; a second failure keeps Save held and says the check failed. Clearing a row's own list removes it, i.e. the row inherits again.
- **Discover sources.** `get-member-challenges` takes no argument: the handler decides what to fetch. `getMemberChallenges(token, 'open' | 'upcoming')` returns **`null` on failure** (an empty list is a real answer), and every caller handles it: the join pass logs and does not run, manual join answers `fetch-failed`, and the handler answers `{ success: false }` for a failed open list. The handler fetches `open` and `upcoming` side by side. `upcoming` is fetched on **every** Discover load, even with `discoverUpcomingHours` at 0, because its ids are what keep chosen lists alive; the result is cached per account for about 60 s (`services/discoverChallenges.ts`: keyed by a digest of the token, never the token; concurrent callers share one request; a failure is never cached; emptied by `forgetAccountMemory` at logout and account switch). `mergeDiscoverLists` builds the shown list against an injectable clock: the open copy wins when an id is in both; an upcoming item stays only while its `start_time` is a finite number after now and at most `discoverUpcomingHours` hours ahead (far end inclusive; one that has already started is dropped — the open feed shows it); open rows come first, then upcoming rows by `start_time` then id, at most 100. Upcoming rows carry `status: 'upcoming'` (the only marker; an open row carries none). A failed `upcoming` fetch leaves the open list as it is and logs the filter and the kind of failure only — never the token or a member. **The upcoming-id set** (`settings/openChallenges.ts`, through the facade) maps id → `start_time`, starts as `null`, is written only by this handler and only from a successful `upcoming` fetch (with **every** id the fetch returned — the window decides what is shown, not what is kept), and is never touched by the join pass. An id the feed drops is **carried over** — the feed drops a challenge the moment it starts, while the open feed may not list it yet — until it is in the open or active list or `UPCOMING_GRACE_SEC` (600 s) after its `start_time`. The set also records when it was fetched: older than five minutes it counts as unknown again, since another process (the CLI) may have chosen photos for a newly announced id since. `isKeptForJoin` keeps an entry whose id is in the open set or the upcoming set, or while **either** set is `null`/unknown, so a restart, a failed first fetch, a stale set or a race with Discover never prunes anything. A request still in flight when the account is forgotten (`forgetAccountMemory` bumps `accountGeneration`) writes none of this and answers `{ success: false }`. `openChallengeCache` holds the **merged** list plus the previously cached items of the carried-over ids, so `get-open-chosen-annotations` resolves rules by title, tags and type for upcoming and "starting now" rows too (`MAX_ANNOTATED_IDS` is 300: the open list plus the 100 upcoming rows). A paid join spends no more than the cost the caller confirmed: `join-challenge` takes an optional `expectedCost` (a finite, non-negative number, else `invalid-args`), and `joinChallengeSingle` answers `needs-confirm` with the live cost — unlocking nothing — when the live cost is above it (the Discover confirmation passes the cost it showed; the CLI's `--yes --max-coins=N` does; `--yes` alone passes the cost `join` printed first). Joining stays tied to the **live open lookup**: the join pass asks for `open` only, and `joinChallengeSingle` joins only an id the live `open` list holds. For an id it does not hold it makes one **live** `upcoming` call — `not-started` if the id is in it (nothing unlocked or submitted), `unavailable` if it is not or the call fails — so the answer holds in a fresh CLI process and never calls a started or joined challenge "not started". The renderer keeps a row that was upcoming and whose start has passed as "Starting now" for up to 10 minutes while the open list lags (re-reading every minute), and re-reads the list at the soonest upcoming start (`useDiscoverRows`). The mock branches on the filter (`mock/endpoints/join.ts`: three upcoming fixtures, 900101–900103, the last beyond the default 24 h window).
- **Library listing.** `get-library-photos(challengeId?, search?, mode?, usage?)` (`ipc/actions/library.ts`) is a read-only listing for the chooser and `list-photos`. `get_photos_private` requires a challenge id, so a caller with none borrows an active (else open) challenge and the result says `allowedKnown: false`; with no challenge to borrow it answers `no-challenge-context`. Walks are throttled to one in flight per process with a minimum gap, and a newer request replaces a queued one (`superseded`). Only the mapped fields `id`, `labels`, `allowed`, `message`, `uploadDate` plus `memberId`, `truncated`, `wonIds`/`wonCount`, `preview` and `readAtMs` are forwarded, and the renderer shows them as text only. A third argument `mode` (`'cached'`, or `'fresh'`, the default and the CLI's) lets the choosers open at once: `'cached'` answers the no-search listing from `services/libraryCache.ts` (memory only, per account, per challenge and per usage, expiring after 5 minutes) before the throttle, as a preview with its marks withheld when only another challenge's or an expired listing is held. Actions of this window that change what a challenge accepts (submit, fill, join, swap) drop that challenge's entry, and a logout or account switch empties the cache (`forgetAccountMemory`); a walk that began before either writes nothing. A fourth argument `usage` (`'submit'`, the default and the CLI's, or `'swap'`, the swap picker's) says which eligibility the `allowed` flags describe, and a listing of one usage answers only that usage (the other's serves as a preview).
- **Rollback.** An older build drops the unknown keys from its settings, profiles and rules when it next saves, and rejects a scenario whose phase uses them. A rule with a close-time condition (`closesAt` / `closesAtTimes`) is left out of the `titleRules` of the `settings.json` mirror, since an older build would ignore the condition and match the rule more widely (an auto-join rule would pay for challenges it excluded). The mirror carries those rules in a top-level key of its own, `closeTimeRules` (each with the position it holds among all the rules), which an older build does not read; `config.json` keeps them as well, and a restore from the mirror (`settings/closeTimeRules.ts`) takes the key out before the frozen importer sees the text and puts the rules back at their positions, so a missing or damaged configuration loses none.

## 4. Semantic / lexicon

- `getSemanticScores()` (`services/semantic/index.ts`) ranks **auto-fill candidate photos only — it is NOT
  part of the vote decision.** It scores each of a photo's labels against the challenge theme separately and
  keeps the **best** (max-pooling); words WITHIN one multi-word label are still mean-pooled.
- **Both sides pool narrowly, and that is load-bearing.** A photo's labels are a bag in which one or two
  entries carry the theme and the rest are scene furniture, so averaging them measured how _generic_ a photo
  was: a real staircase photo scored 0.389 (under the floor, no credit) while a yoga photo scored 0.583 and
  was promoted as on-theme. Symmetrically the challenge vector comes from `buildThemeKeywords()` — url +
  title only, **never `welcome_message`** — because body prose ("made of wood or stone, with people on them")
  drags the pooled theme off its own subject: same challenge, same tag, 0.94 → 0.25.
- It **never breaks a fill**: any failure (missing asset, no theme text, no in-vocab labels) resolves to
  `null` and the caller ranks lexically. `buildThemeKeywords()` returning `[]` — every title word
  was boilerplate or contest cadence, e.g. "Guru of The Week" — is that "no theme text" case, on purpose.
- `SEMANTIC_MATCH_FLOOR = 46` (`services/photoPicker/tiers.ts`) is **build-gated by
  `scripts/validate-lexicon.ts`** (a statistical gate: `p99(unrelated) < FLOOR < p25(related)`), **not
  hand-tuned**. Scores below the floor are forced to 0 (sub-floor cosine is indistinguishable from vector
  noise), not merely ranked low. **The floor is calibrated per pooling shape** — the validator pools exactly
  as the matcher does, so changing one without re-deriving the other silently admits the noise tail.
- Labels must be **stemmed word tokens** — the lexicon has no multi-word keys, so a raw multi-word label
  always misses.

### 4a. Visual re-rank (on-device image model)

- `rankVisually()` (`services/visionVerifier.ts`) runs a bundled, 8-bit quantized **SigLIP** model
  (`zero-shot-image-classification`, `@huggingface/transformers`) over the **top 12 tag-ranked
  candidates** of every challenge. Like the lexicon it only orders photos — it is never part of the vote
  decision. One call site feeds every submission path: `verifyFillPick()` in `services/autoFill/pipeline/verify.ts` (auto, emergency,
  manual, and fill-new fills via `runFillAttempt`, plus swaps via `rankCandidatesForChallenge`), and
  `pickJoinPhoto()` (`services/joinChallenges/photoPick.ts`) for auto-join.
- **Suggestions** (Pick… > Auto, `list-photos --suggest`): `suggest-photos` ranks the library under the same rules as the scheduled fill (`suggestFillPhotos`) without a submitter in its deps, so it can never submit. It has its own photo-stats budget (`createStatsBudget()`), so a ranking neither spends nor trips a running pass's budget or breaker, and one ranking runs at a time process-wide (`suggest-busy` to the rest); every press ranks afresh, so a change of rules or a new upload shows at once.
- **Prompts come from the challenge, never a theme list**: `a photo of <subject>` from
  `visualSubjectWords()` (the title subject — series prefix, negated words and `ignoreTitleWords` removed,
  **unstemmed**, and deliberately without `abstractTitleWords`, which reads "leaves" as a verb) plus
  `descriptionLead()` — the first two sentences of `welcome_message`, HTML and the shared rewards text
  stripped. Unlike the semantic theme vector, the description is safe here: SigLIP reads a sentence as a
  sentence rather than averaging its words, and it is averaged with the title prompt, not used alone.
- **It only reorders and never empties a pick.** A photo's fit is the mean logit over the prompts; photos
  more than `ln(10)` below the best fit move behind the rest, and tag/popularity order is kept inside both
  groups. It **abstains** (original order) when the title has no visual subject, when no photo reaches
  `ABSTAIN_LOGIT` for any prompt, or on any load/inference/URL failure. An abstain reports no visual
  evidence, so the uncertain-photo check falls back to the semantic/keyword evidence. Both thresholds were calibrated on
  16 live challenges (2026-09-24) — re-measure against real shortlists before moving them.
- **Packaging, per shell** — the model is fetched and sha256-pinned at build time by
  `scripts/fetch-vision-model.ts`; nothing downloads at runtime (`allowRemoteModels = false`).
    - Electron: `extraResources` → `Resources/vision-model`, native `onnxruntime-node` in `app.asar.unpacked`.
      The Android-only copies under `dist/` and the standalone `onnxruntime-web` package are excluded from
      the asar, and `scripts/afterPack.mts` deletes other OS/CPU `onnxruntime-node` binaries.
    - CLI: the build embeds a `pnpm deploy --prod` tree + model as a SEA asset (pruned to the host OS/CPU by
      `pruneVisionRuntime`); `services/visionCliAssets.ts` verifies its sha256, extracts it once per version
      into `<userData>/vision/<sha>`, and removes finished copies from earlier versions unless one was marked in use
      within the last hour (an older CLI still running may not have loaded its model yet).
    - Android: `dist/` is the WebView root, so `vision-model/` and the single-threaded ORT WASM files are
      served from it and inference runs on the `wasm` device with one thread.
- **Lite builds** (`build:<os>:lite`, `build:cli:<target>:lite`, `build:android:lite`) ship none of the above:
  `scripts/electron-builder-lite.ts` drops `extraResources` and the transformers/onnxruntime/sharp packages,
  `build-cli.ts --lite` embeds no runtime asset, and `build-react.ts --lite` clears the model and WASM files from
  `dist/` and leaves transformers out of the bundles. `hasBundledModel()` (a fetch of
  `vision-model/config.json` on Android, the `vision-runtime.sha256` SEA asset on the CLI, the model folder
  otherwise; cached) makes `rankVisually()` keep the tag order without a warning. It also keeps updates on lite:
  the Android update check asks for `-lite.apk` (`pickAsset()` never gives a plain suffix a `-lite` asset), the
  CLI's `check-updates` links its own `gurucli-…-<target>[-lite]` binary, and the lite desktop app reads
  `lite*.yml` via the `channel` in its `app-update.yml`. electron-updater's GitHub
  provider replaces that channel with the prerelease one on beta tags and falls back to `latest*.yml` (the full
  build), so `AutoUpdater` turns `allowPrerelease` off for lite.

## 5. Safety / idempotency guards

- **Defensive optional-chaining on every per-challenge API read** — one unguarded throw dumps the entire
  remaining pass into the outer catch, so each per-challenge property access is optional-chained, and each
  challenge body is independently try/caught for isolation.
- The new-entry tracker (`services/newEntryTracker.ts`) compares entry ids as **SETS, not positions** — the
  server reorders `member.ranking.entries` between polls, so a positional diff would force a vote every
  cycle. An empty entries array is **not** recorded over a non-empty baseline (a degraded API response must
  not poison the baseline).
- **Mock/real metadata isolation**: the metadata store is shared and un-namespaced, and mock challenge ids
  never match real ones — so mock mode passes `cleanupStaleMetadata: null` plus an in-memory tracker, or it
  would purge/pollute the user's real `metadata.json`. The join flow follows the same rule: mock passes a
  `null` join-state store and no cross-process lock.
- **Paid-join money safety** (`services/joinChallenges/performJoin.ts`, with the unlock claim in `unlockMarker.ts` and the in-flight lock in `shared.ts`): the order is load-bearing — resolve an eligible
  photo **before** any `coins_unlock` (no photo ⇒ skip, no spend); persist the unlock claim
  (`joinState.json`) **before** the charge so a crash can never let a later pass re-unlock (idempotent
  retry), and if the claim can't be written, don't spend: on Android the background service writes it through the native bridge (`gs_join_state`, strict: a write the bridge refuses throws), and a store that could not be read (the bridge threw, or the app window's start-up read failed) reads as unreadable, never as no claims (`storeLoaded`). Whose coins a claim holds is part of its key: a
  new claim is always written as `<member id>:<challenge id>` (the member id survives a re-login; a token
  does not), so one account's leftover claim never makes another account's join a submit-only retry. A
  bare `<challenge id>` claim, from before accounts were told apart, counts for every account (it can only
  err towards not charging twice). **Claims are never settled automatically.** A claim ends in exactly two
  ways: a paid submit that used it succeeds (the submit proves this account held the unlock, so the claim it
  used goes, bare or not), or the user explicitly forgets it (below). A failure never clears one, a balance is
  never read to decide whether a claim was charged (a timed-out unlock can still commit, a reward can equal
  the cost, another join can be paid in the same pass), and a free join removes none. **Refused vs unclear**
  (`api/api-client.ts`, `api/postOutcome.ts`): `coins_unlock` and the currency spends go through `postOnce`, a
  request that is never repeated after it was sent, and answers `body`, `refused` or `unclear`. A 429 (after
  its Retry-After) and a request that never left (ECONNREFUSED, ENOTFOUND, EAI_AGAIN) are retried like any
  request and are refused when they run out; a 4xx is refused (the server did not process it); a timeout, a
  reset, a 3xx (a redirected POST may have been processed), any 5xx, a 2xx whose body is no JSON object and a
  rejection that is no error object are unclear. Boosts and Turbos keep the normal retrying `makePostRequest`:
  once USED the server refuses a replay, and a single attempt would only lose a boost in its last window. A
  refused unlock gives the claim back (clearing it is retried a bounded number of times; if it still cannot be
  cleared the claim is flagged unconfirmed rather than left looking confirmed) and answers `failed-no-charge`. An **unclear** unlock may have charged:
  the claim stays, stored as `{ unlockedAt, unconfirmed: true }`, and the join answers
  `charged-pending-submit` with `reason: 'unconfirmed'` and `maybeCharged`, which the auto pass subtracts from
  its budget and balance without reporting it as charged. A claim that could not be flagged (the write failed)
  reads as a confirmed one, so the outcome is worded as one — charged, retry the submit — with no `reason` and
  no way to forget it, and the failure is logged as an error. Every claim also records, as information only,
  the balance the caller already had just before the unlock (`coinsBefore`: the manual join's affordability
  read, or the auto pass's own balance; no request of its own, written with the claim before the charge): it
  is shown beside GuruShots' balance now (GUI dialog, CLI hint) for the user to compare with the coin history on
  the GuruShots website, and nothing in the app decides on it. Every later attempt, manual or automatic, only
  submits on that claim (`submitOnly`), so nothing can pay again without asking, and it does so under the
  cross-process unlock lock with the claim read again under it (a claim gone by then submits nothing, a lock
  another process holds answers `busy`); marking a claim joined after a successful submit takes the lock too; a submit that fails on an
  unconfirmed claim answers `unconfirmed` again, and on a bare claim `reason: 'earlier-payment'` (a payment
  record from before accounts were told apart, whose owner is unknown): both are worded for what is not known
  (the GUI and CLI say that a retry only submits the photo, so nobody is charged twice). **Forgetting**
  (`services/joinChallenges/forgetPayment.ts`, IPC `forget-unconfirmed-payment`, GUI "I wasn't charged" on a
  Discover row with a confirmation dialog, CLI `forget-payment <id>`): for a user who checked on GuruShots
  that the coins were not taken. Under the same cross-process lock as the unlock, and refused while a join of
  the challenge is under way, it re-reads the claims (an unreadable file aborts), and deletes this account's
  claim for the challenge only when it is still unconfirmed; never a claim known to have been charged. A
  bare claim from before accounts were told apart is **never** forgotten (`legacy-record`): it may be another
  account's protection against a second charge and nothing on the device can tell whose, so it stops applying
  to the other accounts when the account that paid joins through this app (the join replaces it, in one change of the claims, by
  that account's own joined claim), and otherwise clears after 30 days (any claim, bare or any account's, older than 30 days is pruned at the next open-list pruning,
  except this account's own keyed claim of a challenge still in the list just read: a bare claim is never kept by
  the list, since the list says nothing of whose it is; no challenge lives that long, and it ends the keeping of
  other accounts' records and balances). The
  GUI offers no "I wasn't charged" for it, and its message tells the account that did not pay it can join on
  the GuruShots website meanwhile. A key with a colon is never read as a bare claim, and the IPC handler and
  the CLI take only a plain challenge id (digits), so a crafted id cannot name another account's record. It
  refuses when the account cannot be told. The next
  join then asks for the price like any first one. Every change of the claims is read-modify-write of one
  file for every challenge, so it is made under its own cross-process lock (`joinstate`, taken after any
  challenge lock and waited for up to half a second; when it cannot be had the change fails, and an unlock
  records no claim, so spends nothing). Every writer of the claims reads them with
  `readUnlockedState` and writes nothing when the file is unreadable (read as empty it would wipe every other
  claim; `markUnlocked` then returns false and nothing is spent), and logs by challenge id only, never by the
  member id in a key. `markUnlocked` is a compare-and-set inside the locked change: it refuses when this
  account's or a bare claim for the challenge already exists, so two writers never overwrite each other's claim.
  The file is written whole to a temporary file (owner-only, flushed to disk, then renamed over the file, and its
  directory flushed where that can be), so a reader never sees it cut off; the temp files a crash left beside it
  (its own name pattern, untouched for a minute) are removed at the first read or write; an empty file reads as
  unreadable. A successful paid submit does **not** delete the claim it used: the claim stays, marked `joinedAt`
  (and nothing else but the time of the unlock: the balance before the payment, and any doubt about it, have no
  purpose left), because a process that read the open list before that join and then spent a
  while picking a photo would otherwise find no claim under the lock and unlock the challenge a second time. A
  joined claim is never forgettable, makes every later paid attempt refuse (`failed-no-charge`: no unlock, no
  submit) wherever it is met (before the pick, under the unlock lock, under the submit lock), and is pruned like
  any other, counted from its join. A refused unlock's claim is removed with one brief retry when the file's lock
  is held (never when the file is unreadable), else flagged unconfirmed. Forgetting a claim whose file is locked
  answers `busy`. Spends of currency (keys, swaps, fills) that are unclear say so (`outcome: 'unclear'`,
  never "rejected"); an unclear swap re-reads the live entries and records the swap in the swap-back ledger
  when it did land; and a scenario step whose spend is unclear counts toward the scenario's `spent` limit
  (conservatively, so a limit is never exceeded), is retried from the same step, and says it "may have gone
  through" (the status line words it in the user's language from the marker on `inFlight` or the stopped rule's
  `fired` record and the action, not as a skipped step). Such a step as a rule's first commits the rule (`inFlight` at that index), so the
  retry resumes there. The retry of such a step never spends again: it only looks at the live challenge, passes
  the step over when that positively shows it took effect (the boost unlocked by a key, the exposure full, the
  replacement photo entered) and goes on, and otherwise ends the rule — a swap whose replacement a selector
  chooses cannot be shown to have landed, so it ends the rule too — instead of spending on it or on a later step. A **paid** join whose account cannot be identified (a real claim store and a profile read are
  wired in, but no member id came) does nothing paid: no unlock, no submit, and it answers `failed-no-charge`
  with `reason: 'account-unknown'`, which the GUI and CLI word as "could not confirm the account; this attempt
  spent no coins", not as "no coins were charged". The reasons are one union (`types/join.ts`) shared by core
  and renderer. Claims whose challenge is no longer open are dropped when a successful, non-empty open list is
  read (`pruneClosedClaims`, after the pass or manual join): only this account's own keyed claims, only ones
  older than six hours (a list read a moment ago cannot know of a join under way), never on an unknown account,
  never another account's or a bare one by that rule (age is the only way those go, above), and never a
  challenge whose unlock lock another process holds. A manual join or an auto-join pass that
  finds this account's claim skips the price, balance and budget checks and only submits (`submitOnly`: the
  join re-reads the claim and refuses to unlock if it is gone); with no eligible photo it answers
  `charged-pending-submit` with `reason: 'no-photo'` only when the photo library was actually read and held
  nothing eligible (the GUI and CLI lead with adding an eligible photo, and name Must Include Tags and Submit
  Even Without a Tag Match only as what can also block the pick; Submit Only Chosen Photos is lifted for a
  join whose coins are spent, and only for a paid one). A library whose read failed (both unfiltered reads
  failed on their first page: `readState.firstPageFailed` out of `getEligiblePhotos`, carried through
  `trace.readFailed` to `pickJoinPhoto`) is `unreadable`, answers plain `charged-pending-submit` (the
  ordinary Retry) and skips a free join; an unconfirmed claim's wording wins over "no photo". a per-process in-flight `Set` **plus** a
  cross-process lockfile (`acquireUnlockLock`, real-fs platforms, fail-open; Capacitor and the headless service
  are single-process and take none) guard the
  check→unlock→mark section, a submit that continues on a claim, and the forgetting of one. The lock file holds a
  random owner token and is released only while it still holds it, so a lock that was taken over is never
  deleted by its old owner; a held lock is touched every 20 s, so only the lock of a crashed owner goes stale
  (60 s untouched), and a stale one is taken over atomically (renamed to a name of its own — only one process can
  — then checked to be the one seen, and put back with a hard link if it was a live one: a link fails rather than
  replace a lock created meanwhile, and only where the filesystem has no hard links does a rename stand in, while
  the place is empty). A challenge's lock (`joinlock-<id>.lock`) and the app's own (`statelock-<name>.lock`: the
  claims file's, the scenario state file's, a challenge's scenario steps) are different files whatever their
  names, so no id can name one of the app's. When a lock cannot be made at all (permissions, a full disk) the
  challenge's fails open (a spend still needs its claim recorded first, by compare-and-set under the claims-file
  lock) and the app's own fail closed, as `unavailable` (not held, and not to be had: told from busy, and said
  so, to the user and in the log): nothing guards what they guard but them. A corrupt/unreadable join-state **refuses to spend** (fail-safe, not fail-open);
  the pass is cancellation-checked between candidates and before each spend, and each candidate is
  independently try/caught. Decision precedence in `VotingLogic.shouldJoinChallenge` (pure): a rule opt-in
  (a named profile, or an inline `autoJoin: true` on the rule) wins over the type-exclude veto; otherwise the
  default scope is join-all, an `autoJoinTypes` include-list (when non-empty) narrows it, and
  `autoJoinExcludeTypes` subtracts. The join window (`joinWindowRefusal`) is evaluated **after** the scope
  filters — so an out-of-scope candidate still reports why it is out of scope — and **before** the cost
  branch, so it gates free and paid candidates identically and defers a paid one before any `coins_unlock`.
- **Fail-soft config parsing** is pervasive: `getScheduledFillState` and `getVotingPauseState` (both built on
  the shared `_triggerWindowState`) wrap their whole body in try/catch and return inactive. The two fail in
  _opposite_ user-visible directions, deliberately: a broken scheduled fill stops forcing 100%, a broken
  pause keeps voting. So the corrupt-value policy is per-feature, not shared — scheduled fill substitutes
  the schema default (failing to "never in window" would, under replace mode, block all threshold voting),
  while the pause turns **off** (`onCorruptDuration: 'off'`) and clamps an over-range duration
  (`maxDurationMin`), because substituting or honouring those would both be fail-_closed_ and could stop
  voting for good. Both catches **log**: the orchestrator has a per-challenge catch that reports the errors
  it sees, so a silent swallow here would be the least visible failure in the pass.
- **Sleep-boost guards** (`windows/suspendBoost.ts`, `windows/quitGuard.ts`): the remembered challenge list carries
  the `mock` flag it was fetched under, and the sleep path acts only when it matches the current mode (mock mode
  also uses the in-memory entry-age ledger, never the real file), so a real list is never boosted from mock mode
  or the reverse. A module-level re-entrancy flag stops two quick sleeps from sending twice and is released in
  `finally`, since the batch can stay pending across the sleep. The path never throws: the whole body is
  try/caught and logged, because it runs from an event listener. After a successful send `markBoostApplied`
  flips the remembered boost to `USED`, so neither a later sleep nor the quit guard counts it as pending until the
  next fetch replaces the list; an unconfirmed reply is logged as "not confirmed", never as a failure. The quit
  guard remembers a list only from a fetch that did not fail (`ipc/actions/account.ts` skips `fetchFailed`;
  `rememberChallenges` ignores a non-array), so a failed fetch keeps the previous list rather than blanking it.
- **Log-injection guard**: API-sourced challenge ids/titles are CR/LF-collapsed via `format/logSafe.oneLine()`
  before interpolation (imported directly, not off the logger, because the logger is mocked in much of the
  test suite).

## 6. IPC contract

- `ipc/manifest.ts` is the **dependency-free single source of truth** for the whole `window.api` surface —
  four lists: `invokeChannels`, `aliases`, `sendMethods`, `eventMethods`, plus the Logs window's subsets
  `logsWindowInvokeChannels` / `logsWindowEventMethods` and the settings it may read, `logsWindowSettingKeys`
  (`language` only). Both shells generate from it:
  Electron `preload.ts` builds `contextBridge.exposeInMainWorld('api', …)`; Capacitor
  `bridge/capacitor.ts` builds the identical surface in-process.
- **Drift is CI-enforced** by `tests/ipc/manifest.test.ts` at the name level. Signatures travel through the
  `WindowApi` type (`types/ipc.ts`, derived from the manifest lists and every `buildHandlers()`), so a
  renderer call in a type-checked file is checked against its handler's parameters and result — only as
  precise as that handler's type annotations.
- Handler shape: every `ipc/*.handlers.ts` exports `buildHandlers(deps) → {channel: impl}` **and**
  `register(ipcMain)`. **CLI and Capacitor reuse the same handler modules** (`cli/commands/*.ts` lazily
  require `buildHandlers()`) — never write a parallel implementation.
- **Add a channel end-to-end**: (a) add the channel string to the right list in `manifest.ts`; (b)
  implement it in the matching `ipc/*.handlers.ts` `buildHandlers()`; (c) Electron picks it up
  automatically via `preload.ts` + the module's `register()`; (d) ensure the handler module is in
  `capacitor.ts`'s spread for the Capacitor build.
- Handlers **never throw to the renderer** — they return a tagged `{ success, error }` object. Shared
  preconditions use a Result guard: `requireAuthToken()` (`services/auth.ts`) returns
  `{ ok: true, token, settings }` or `{ ok: false, response }`, and callers do
  `if (!guard.ok) return guard.response;`.
- Handlers explicitly **whitelist** the fields returned to the renderer so internal result shapes don't
  leak (`toSafeTurboResult` in `ipc/actions/turbo.ts`; apply-turbo returns only a sanitised message, and
  its raw response reaches the log only as the redacted `safeRaw` summary).

## 7. Persistence & platform detection

- **Don't hand-roll `fs`.** `createJsonStore({fileName, prefKey})` (`settings/storage.ts`) is
  the reusable three-platform JSON store: sync fs at `userData/<fileName>` (mode `0o600`) on Electron/CLI,
  hydrate-once cache + ordered async write-behind to `@capacitor/preferences` on Capacitor, and the native
  keyed preference bridge (`settings/storeTransport.ts`) on the Android headless service. Every consumer is
  listed in the store registry `settings/localData.ts` (`LOCAL_DATA_STORES`) — also what "Delete all local
  data" removes — and `tests/settings/localData.test.ts` fails for a `createJsonStore` call site missing there.
- **The configuration (`config.json`, `ConfigV2` in `types/config.ts`, `version: 2`; the `gurushots-config` key on
  Android) is the app's settings blob and the only source of truth.** It holds `app` (preferences and app-state
  flags), `auth` (token, API headers, last user name, chosen-photos account), `defaults` (the global per-challenge
  values), `profiles`, `seededProfiles`, `scenarios`, `rules`, `challenges` (per challenge id: its `values`, a
  `suppressRuleProfile` flag and its `pins`) and, once an import ran, `imported` (when, the unresolved references as
  structured entries — the rule number from 1 and its title, the profile name, or the challenge id and title where the
  import knew it, and the profile or scenario they name — or as the text an earlier build stored; whether the report
  was seen). Title pins stay in their own cache store. A load validates it and fills what it lacks
  over the defaults (`loadValidation.ts`); `persistence.ts` owns load and save, `storage.ts` the bytes.
- **`auth` never reaches a renderer.** `toRendererSettings` (`ipc/rendererSettings.ts`) takes the block out of what
  a window receives and answers only `hasToken`, derived from the stored token; `withoutRendererHiddenKeys` drops
  `auth`, `token`, `hasToken` and `apiHeaders` from a renderer's write, and `lastUsername` and `chosenPhotosMemberId`
  (which a renderer may read one at a time) as well. Only the main process writes the sign-in state.
- **`settings.json` is a one-way mirror of the configuration, in settings format 1 (`settings/formatOneMirror.ts`).**
  It exists so that an older build of the app (which applies its own schema, prunes the keys it does not know, resets
  values it cannot validate and writes the whole file back even unchanged) that runs on the same data starts signed in
  with the current settings. The invariant: **`config.json` is the only source of truth; `settings.json` is written
  from it after every save that landed and is never read back, except by the import, the recovery of a missing or
  damaged configuration, and the one exception for the sign-in below.** What an older build changes in it is
  overwritten by the next save or start; nothing but the sign-in that the new build holds can be reset by an older one. `toFormatOne(config, titlePins)` derives the text: the renamed keys
  (`V1_KEY_RENAMES`) under their format 1 names (where a key exists under both names the current one wins, so the same
  configuration always mirrors to the same text), `auth` back among the top-level keys, `challenges` split into
  `perChallenge`, `titleProfileSuppressions` and `entryPins`, `defaults` as `globalDefaults`, every one-time migration
  flag set (an older build never migrates the values again) and no `version` or `imported`. An empty or blank `timezone` is written as `UTC` (the configuration's meaning of it; a format-1 build read `''` as Europe/Riga, so `settings/formatOneTimezone.ts` translates both ways). The mirror is written
  after the configuration is stored, as an overwrite of the text it read, and skipped when it is unchanged:
    - **Desktop and the CLI (`mirrorSync`)** read `settings.json` first, then the stored configuration, and write with
      `overwriteIf(current, text)`; a mirror another process wrote in between makes the write a conflict, and it is
      made again from the configuration as stored then (3 attempts). The compare and the write are made under the
      settings lock (`settings/settingsLock.ts`, the lock the import runs under) with a short wait: a mirror that cannot
      take it in time is given up quietly, and the next save or start makes it. Where nothing is stored to mirror no
      lock is taken.
    - **Android (`mirrorQueued`)** is chained on the configuration write's `landed` outcome: it waits on it (nothing is
      mirrored from a write that did not land), then runs on the mirror store's own write chain, reads `settings.json`
      and the stored configuration from Preferences, and writes with a compare-and-write (`casStored`), again up to 3
      attempts. The background service makes the same overwrite through the native bridge's compare-and-write. The
      title pins and the import marker the mirror carries and records are read from Preferences (`peekStored`), not
      from the window's cache, which may be behind what the service saved.
    - A failed or given-up mirror is logged (never its text) and made again by the next save and the next start
      (`_verifyMirror`, once per process, once the stores are read); a title-pin change re-mirrors too. Nothing is
      mirrored while the stored settings are unusable (`blocked`), so a file the user may need is never written over.
    - The file the user had is kept once as `settings.json.original` (`gurushots-settings_original`, shared and atomic,
      never replaced) before the first mirror write; `importMarker` records that the mirror has started, after which
      `settings.json` is the app's own output. A logout clears the token and API headers from that copy as well, and
      from every copy set aside of a settings file that parses (`config.json.corrupt-<time>`,
      `settings.json.unimportable-<time>`, and the Android `gurushots-config_corrupt-…` /
      `gurushots-settings_unimportable-…` keys): `scrubCopiesAfterSignOut`, run at once after a sign-out
      was saved (a token that was stored and is cleared: a logout, the start that clears the token when Stay Logged In
      is off and one is stored, a sign-out adopted from an older build), not whenever the mirror next runs, which it may
      not, or may find busy; the Android window waits for the configuration's write to land and clears nothing when it
      did not. Every sign-out is recorded (`signOutScrubPending`, a value of its own for each, in the import marker; a missing
      marker is made for it) and the record is cleared only when every copy was rewritten (the rewrites report whether each
      landed): a copy that could not be is tried again at the next start or save (`finishDeferredScrub`; a desktop looks
      again at each save only after a rewrite failed). The background service can reach none of the copies in Preferences
      it cannot list, so it leaves its record, and the app window clears them when it next starts
      and again at each change it saves (`finishDeferredScrub`), since the service may sign out while the window is open; a look asked for while one runs is
      made when it ends, and only the record a look has seen to is cleared, against what is stored (a sign-out recorded since stays owed). Never because the configuration merely holds no token, as the defaults of a damaged one do: the
      sign-in in the copy the user is fixing is not theirs to lose. The last user
      name and the chosen-photos account go out of the copies too (never out of the configuration or the live mirror: the
      login form is prefilled from them). A copy that does not parse is left as it is.
      At each start (`scrubOldCopies`) the copies set aside more than 14 days ago (the time is in their name; one without a
      time counts as old; not `settings.json.original`) also lose the sign-in they hold, every one that can be read (a damaged copy cannot), a logout that never came
      having left it there, and keep their settings for recovery.
    - **The one thing taken back is the sign-in, at every mirror write.** The marker keeps two fingerprints of the sign-in
      this build wrote — the hashes of the token, the API headers, the last user name and the chosen-photos account, each
      of its own (53-bit non-cryptographic hashes, not secrets: a low-entropy field such as the user name can be found
      by brute force, and the marker sits beside files that hold the same values in plain text): `signInPending`, recorded right before a mirror write (the write is not made when the
      record fails), and `signInConfirmed`, once it landed. Recording a pending one also keeps the fingerprint of what
      `settings.json` holds then, when it is this build's, as the confirmed one; confirming clears the pending record only
      when it is the one confirmed, so the other Android context's pending record is not dropped by this one's
      confirmation (there is still one pending record, shared by the Android window and the service, and recording a
      new one replaces the other's). Before every write — inside the settings lock, on the start and on each save, in the window's queued
      path and in the service's synchronous one — the sign-in fields a `settings.json` that parses holds are compared
      field by field with the recorded ones: a field whose hash is none a recorded fingerprint has for that field was
      changed by an older build (a sign-out, or another account, before the start or while the app ran), and those
      fields, only them, are adopted into `auth` first, the configuration saved before the mirror is made from it
      (`_adoptSignIn`, answered to the mirror through its hooks). A field the file does not hold, or holds as the wrong
      kind, was not decided there (an older build drops the keys it does not know), and a field this build changed
      since it last wrote is not taken for the older build's. If that save fails nothing is written and nothing is
      recorded until a later attempt adopts it; one line, without values, is logged once it is stored. A sign-in is a
      decision of the user, not something an older schema can get wrong. Nothing is adopted without a recorded
      fingerprint, from a file that does not parse, or while the configuration in use is the defaults of a damaged one.
    - **A `settings.json` that does not import is never mirrored over.** In the `settings-corrupt` state the first save
      sets it aside as `settings.json.unimportable-<time>` (the Android key `gurushots-settings_unimportable-<time>`)
      first, then mirrors; the notice says where it went (`settingsSetAside`; in the Android window only once the queued
      set-aside has landed). If it cannot be set aside nothing is written over it, and the next save tries again. The
      background service cannot set a file aside and leaves it as it is, quietly, for the window to do. That copy is
      the file the user fixes in place, so a Re-import imports from that copy, or from `settings.json` until there is one. The copy
      is the one of the last episode only (`legacySetAside`; never an older one in the folder), and where it was set
      aside is recorded in the import marker (`unimportableCopy`, written when the set-aside lands, by compare-and-write
      like the rest of it; the Android key on Android), so that a re-import in another process (the CLI) or after a
      restart of the app finds it again; the marker is a file the user can edit, so the path is taken only if it is beside
      settings.json and named as such. It is forgotten when a re-import, Start fresh or a retry succeeds, when another
      episode begins, and when the copy is gone (settings.json is imported then). A save never forgets it, in any process
      (a CLI vote that saves while the GUI's episode runs leaves it), and a recorded copy older than 14 days is no
      longer used: a much later re-import reads settings.json. The notice and the CLI name the
      file a Re-import would read (`reimportSource`; the IPC answer of a re-import says which it read), and the
      guidance says "fix settings.json" before a set-aside and "fix the file at {path}" after it.
- **Import and recovery (`settings/legacyImport.ts`, `persistence.ts`).** With no `config.json`, the first load imports
  `settings.json` under the import lock (Android has none: the native compare-and-write of the configuration decides
  which context is first) and writes the marker (`v2-import.json`, kept outside `config.json`, so setting the
  configuration aside never makes the next start import unasked). An import reads a `timezone` of exactly `''` as
  Europe/Riga, the meaning it had in format 1 (`withImportedTimezone`). A damaged `config.json` is set aside
  (`config.json.corrupt-<time>`; `gurushots-config_corrupt-<time>` on Android) and the configuration is restored from
  `settings.json`; a missing one, once the import has run and the mirror has started, is restored silently with a log
  line. A restore keeps the `imported` record the marker holds, so the import report is not shown again. The load
  answers a recovery state, which a window shows as a notice and the CLI prints (`getSettingsRecovery`):
  `settings-restored` and `settings-corrupt` (notices; saves work), `settings-unreadable` (`config.json` cannot be read
  or set aside), `settings-import-failed` (no `config.json`, and `settings.json` cannot be imported) and
  `settings-import-retrying` (the same, for a reason that may pass: see below) block saves until fixed. A damaged `config.json` that `settings.json` cannot restore because the file itself cannot be imported
  (`corrupt`, `migration-failed`, or `inaccessible`: a read error that retrying does not cure, such as no permission, as
  against the transient EBUSY, EAGAIN, EINTR, EMFILE, ENFILE, ETIMEDOUT and EIO) is `settings-corrupt` for the rest of the process, however often it is read: the
  failed restore is remembered (`importFailure`), so a later read does not turn it into the blocking
  `settings-import-failed`. A new process that finds the configuration still missing and the mirror unimportable reports
  `settings-import-failed`. A restore that could not be tried just now (the import lock held by another process, a read
  or a write that failed once) says nothing of the file: it is the retrying state (`settings-import-retrying`, blocking;
  `damagedAt` is where the damaged `config.json` went, when there was one) with wording of its own in the GUI (both
  languages, an Android variant), the CLI and the usage docs (the file could not be read just now, the app tries again by
  itself, nothing was overwritten) and Retry as its only action, not Start fresh; saves are refused, nothing is mirrored over it, and a later read tries again after a wait that doubles from one second up to five minutes
  (`retryNotBefore`), the failure logged once per distinct failure, with no title-pin rewrite in between. While a window listens for recoveries
  (`onRecoveryChange`) the read that tries again is made by a timer once the wait is over (`_scheduleRetry`, unref'd), so
  the user is told when it comes through; a restore that still fails 8.5 minutes after the first failure (counted in time, not in tries, so that pressing
  Retry does not bring it nearer; the wait is at its ceiling by then) is given up as one that will not pass: `_settleUnusable`, the same state as a damaged `settings.json`
  (`settings-corrupt`, saves allowed, the file set aside before the first save mirrors over it, or left as it is when it
  cannot be read). A file that
  turns out damaged on a retry settles like one found damaged at the first try (`settings-corrupt`, not blocking). On
  Android a configuration the window only holds in its cache until the queued write lands (`storage.isPersisted`
  false) is no proof of anything: a read of it leaves the block, the wait, the log and the notice as they are and
  mirrors nothing; once a read finds it stored they are cleared, and `settings.json` is brought up to date. A restore
  counts as one when its own write has landed (`_awaitRestore`): while it is in flight the notice has nothing to say
  (`getSettingsRecovery` answers null unless an earlier try left its block), and when it lands the block of an earlier
  try is lifted and the window is told, so the notice says restored. Each import attempt has a number, and only the
  latest one hears how its write ends (`_beginImport`): the late failure of an attempt that a later one has
  replaced (the read a dropped save causes begins the next attempt before the failure is reported) says nothing of the
  state now. A restore that fails late is a restore that did not happen, and is tried again like any other, so a
  `settings.json` found unusable then settles like a first-try failure (`restoreRetryPending`, which only a restore
  still to be retried sets, never a Start fresh or a re-import that fails late: a configuration that goes missing
  later, with an unimportable `settings.json`, is a blocked import). Retry, and Start fresh that finds the configuration restored meanwhile, end the episode as the
  automatic path does (`_finishRestore`: the restore they put in place counts as restored once it has landed, so a later
  sign-out an older build made is adopted again), and so does a retried restore that finds another process restored it
  (`adopted`). A restore whose `settings.json` holds no sign-in (a sign-out an older build made) clears the sign-in out of
  the copies kept of the settings files, as after any sign-out. A sign-out made while a restore is on its way or waiting
  is recorded in the import marker (`signOutOwed`, a missing marker made for it) as `{ id, at, fingerprints }`: the
  fingerprints (`signInFingerprint`, one hash per field, never a value) are those of the sign-in the mirror last wrote to
  `settings.json` and of the sign-in `settings.json` holds when the logout is made. The record signs out that sign-in and
  no other: `_applyOwedSignOut` (looked at when a process starts and when a restore lands) blanks the token and the API
  headers only where the token in use is one of the named (`tokenInSignIns`), in the configuration and the mirror, and
  clears the copies kept of the settings files by the same match (`scrubCopiesAfterSignOut(…, fingerprints)`). A later
  login has another token and never matches, so no login path touches the record, and the order in which the stores land
  (the Android window's separate queues, another process) cannot make the record undo it. A logout made when no sign-in can
  be named is refused while `settings.json` cannot be read, and recorded as nothing to sign out otherwise. The record is
  removed (`_settleOwedSignOut`) once nothing that holds the sign-in remains to be cleared: not while a `settings.json` is
  still to be set aside (a copy to come, cleared at the moment it is set aside by `_scrubAsideIfOwed`), and at the latest
  after the 14 days the copies set aside keep their sign-in (`scrubOldCopies`). A removal that is refused or fails is
  harmless and is not replayed: the record applies to nothing once the sign-in it names is gone. A damaged `config.json.corrupt-<time>`
  does not parse, so no sign-out or age rewrite can touch it: the notice that names it says it may still hold the
  sign-in and advises deleting it, and never says a logout cleared it. A record the Android window queued and could not store is logged and shown as a change not saved, and
  still holds in that process (`owedMemory`) until it is applied.
  On a desktop the marker is changed under the settings lock (`underSettingsLock`, re-entrant within a process, so the
  mirror's and the import's own changes do not wait for themselves; `writeNow` also reads again before it writes, as a
  second guard). Every change of the marker has one contract (`changeMarker`): it waits for the lock, answers
  `done`, `queued` or `failed`, and a change that failed is kept in memory and made again with the next save or start
  while the app runs (said in the log once per change; it is not kept if the app is closed first). A replayed change
  guards itself by the condition it served and makes no change once that has gone (a copy is forgotten only while it is
  still the one recorded, a set-aside owed is cleared only while it is still the same record, the time the copies were
  cleared is the time of the clearing). A change a caller is refused is never kept: an owed sign-out that cannot be
  recorded is refused, and one that cannot be removed stays, harmless. A refused sign-out makes `clearAuthToken` throw
  `LogoutNotSavedError`, and each shell tells the user truthfully (the CLI exits 1 saying they are still logged in, or
  prints that the logout is recorded; Electron's main process shows a dialog and keeps the window; the web shell answers
  `logout-not-saved` and Capacitor rethrows, and the App shows an alert instead of the login screen, saying whether the settings refused it or something else failed, and that
  auto-vote is stopped and to start it again; the Electron dialog says the same, and when the main window went away meanwhile it is opened again,
  not the login form, since the sign-in was not changed). A record the Android window could not store is told as its
  own notice (`logout-lost`: not recorded, holds only while the app stays open, log out again if it closes first). A marker made only
  for such a record has no `importedAt` and does not stand for the import (`isImportMarked`); `configFrom` records what
  made the stored configuration (`import`, `restore`, `fresh`), and a configuration found there that another process's
  Start fresh wrote is not a restore: it is reported as what it is and strips no sign-in from the copies. Start fresh with a `settings.json` that cannot be read
  keeps nothing and writes the defaults, saying that the file could not be read and was left as it is (`kept:
unreadable`; the mirror never writes over a file it cannot read, and `legacyAsideOwed` in the marker has it set aside, in any
  process, before the first mirror write once it can be read; Start fresh is refused when that cannot be recorded). The CLI refuses `start-fresh` while the retrying state
  stands, unless `--force` is added. A damaged configuration the window could not move aside (the copy in Preferences was refused) is handled as a failed
  move is on a desktop: it is still what is stored, so nothing restored over it counts as restored (the restore queued
  behind the move would only be declined), saves are refused (`settings-unreadable`, blocking, announced to the window)
  and `settings.json` is not mirrored over; the cache shows what Preferences holds (and nothing is told of the restore
  the move was queued with), the move is tried again by a later read after a wait that doubles (`moveRetryNotBefore`),
  and the copy the move would have made is not counted (`hasBackupKey`). A restore's late failure is announced
  too (a dropped save reports only once), and only an import that has started takes the place of an attempt in flight:
  Retry, Start fresh or Re-import that fail at once, or find the configuration there, leave a restore's landing alone. The window is told (`onSettingsRecoveryChange`,
  broadcast by the handlers) when a block ends or the state changes, so an open notice refetches and shows the
  restored notice. The notice is a named region only while it has something in it; a dismissed outcome returns focus to the
  button that ran the action, else the notice's heading, else the element the page gives it (`returnFocusTo`: the
  Login heading, the App `main`, named by what it holds; the page makes it focusable), never an empty element. A session
  that is stored while the Login page shows, without a login made there (the restore that was waiting came through),
  moves on to the app as a login does: the page asks the shell for it (`window.api.login()`, which Electron's main
  process answers by swapping the windows and the web shell and Capacitor by mounting the app) when the settings change
  and say a session is kept. A read before the Android window has hydrated its stores (`not-loaded`) is not a recovery state: the
  defaults answer, nothing is blocked or logged as an error, and a save is refused until the stores are read.
  `retryImport`, `startFresh` (the file is set aside as `settings.json.original`, or as `settings.json.unimportable-<time>`
  when that is taken, before anything is mirrored over it) and `reimportFromV1` (the configuration in use is set aside)
  are the explicit ways out (`settings-recovery` in the CLI). A re-import takes everything from `settings.json`, the
  sign-in included, and sets the configuration it replaces aside with its sign-in (the notice and the CLI say where);
  it is not offered on Android, where there is no file the user can fix. Start fresh keeps `settings.json` beside it
  and says where (`startFreshDetailed`; the IPC answer carries `kept`: `path` with the path, `stored` for the Android
  copy in the app's own storage, `pending` when that copy could not be written yet, `none`, or `adopted` when a
  configuration was in place already, such as a restore that came through meanwhile: nothing is reset and nothing kept), or that there was none.
- **The importer is frozen (`settings/importV1/`).** The format 1 load pipeline lives there as a copy (schema,
  merge over the defaults, the eight one-time migrations, load validation, prune, key renames, conversion to a
  configuration), so a later change to the live settings cannot change what an older file imports as; it runs in
  memory and writes nothing. It keeps every key the live schema defines (the file may be the app's own mirror). Proofs,
  all under `tests/settings/`: the oracle (`tests/helpers/v1Oracle`, a frozen copy of the format 1 resolver) and the
  equivalence harness (`v2/equivalence.test.ts`) ask the oracle and the live code the same questions for every fixture
  and seeded random file, with `v2/golden.test.ts` pinning the oracle's own answers (`__golden__/oracle.json`);
  `formatOne/roundTrip.test.ts` generates configurations from the live schema, so a setting the importer would drop
  fails CI; `formatOne/olderBuild.test.ts` loads the mirror with the 1.12.2 build's key set and load frozen from
  `master` (`tests/helpers/olderBuild/master1122.ts`), and it must stay signed in with every key that build knows.
- **The title pins and the import marker are shared stores (`createJsonStore({ shared: true })`).** The Android
  service writes them too, so every change is made against what is stored when the write is made — never the app
  window's cache written whole: `updateThrough` (the window) re-reads and saves by the native compare-and-write, made
  again on what the service saved meanwhile, and the service's `headlessUpdate` does the same through the bridge
  (`updateNow` where the write is made at once, `peekStored` for a read of what Preferences holds). The native
  `SideStores` takes both keys by compare-and-set only, like the configuration. `mergeTitlePins` and `importTitlePins`
  answer once the write is made where that is at once, and once it is queued in the window (a failure there is logged).
- **The Android configuration blob has two writers and is changed by compare-and-set.** The app window (through the
  plugin's `compareAndWrite`, behind its cache) and the background service (`HeadlessStore.write`) both go through
  the one synchronized `SideStores.compareAndSet` on the `gurushots-config` key, which takes one JSON object of at
  most 2 MiB and refuses a plain write. A save is accepted only while the blob still holds what the writer last read;
  otherwise the writer reads again and makes **only its own change** again on what is there (`rebaseSettingsText`,
  a three-way merge of the text it was made from, the changed text and the stored one: nested objects merge key by
  key, and where both sides changed one value the writer's wins), up to 5 attempts. The writer's text is the blob
  persistence writes — the stored values over the defaults — so the earlier and the stored text are put over the
  defaults the same way before they are compared: a setting absent from the stored text but filled by its default in
  the writer's text is not a change the writer made. A blob that cannot be read is
  never overwritten, and a save that is not made is logged and leaves the window cache showing what is stored.
  A window save given up (5 conflicting attempts, a refused save, or a plugin error) is not silent: the window's
  `get-settings-recovery` answers the recovery of the stored settings first (`{ code, path, blocking }`, and `settingsSetAside` once an unusable `settings.json` was set aside; one of the
  four codes in the import-and-recovery bullet above) and else `{ code: 'settings-save-dropped', path, cause }`
  (`getSettingsSaveDropped`), the same `settings-changed` signal a write sends is emitted so
  `SettingsRecoveryNotice` re-reads, and it tells the user in what / why / next terms that the change was not saved
  and the setting shows its stored value again. `cause` is why the save was given up and words the _why_:
  `conflict` (the background service kept changing the settings), `too-large` (the blob is past the size the native
  store takes; the next step is to remove per-challenge overrides and scenarios) or `storage` (the store refused or
  failed the write); a cause the notice has no wording for reads neutrally. `serial` counts the saves given up: a change of the user's that
  is given up is a notice of its own even when it repeats the cause of the one shown (the window shows a dismissed notice
  again for a new `serial`, and for another code or place), while the restore of the configuration, which a read tries
  again at once, reports a repeat of the same cause once. It clears when a write issued after the dropped one lands. On Android the damaged copy of a corrupt blob is kept under a `<key>_corrupt-<time>` preference key,
  which the user cannot open, so that notice says the app kept the copy and the settings were reset rather than
  naming a path (`usePlatformCapabilities().settingsFile` is false there).
  `setSetting` hands `saveSettings` only the changed key, so the service's own load-and-save has no stale whole blob
  to write back. Desktop and the CLI write the file atomically and are unchanged.
- **Session markers and "Delete all local data".** Two processes can hold the user-data directory at once, so each
  running one leaves a marker file there (`settings/cliSessionLock.ts`): every CLI command that loads
  the settings, which a load can write back and a command can spend from (all but `help`, `--help`, `-h`, `licenses` and
  `reset-data`; taken once in `cli/cli.ts` before the settings are first touched, released when the process exits, and
  best effort: a marker that cannot be written is one warning, not a failure) holds `cli-session-<pid>.lock` (a CLI
  marker named just `cli-session.lock` counts the same), the `pnpm web` server
  holds `web-server-<pid>.lock` while it listens, and the desktop app holds `desktop-app.lock` for its lifetime. Each
  CLI process and web server has its own file, so several can run at once and "held" means any of them is live; a
  holder removes the markers of its kind whose process is gone when it starts. A marker names its process id.
  The holder checks the clock every 2 s (`TICK_MS`) and rewrites the marker once a beat of wall-clock time (30 s,
  `HEARTBEAT_MS`) has passed since its last write: timers do not count a machine's sleep, so after waking the marker is
  rewritten within one tick (the desktop app also rewrites it on the `resume` event); a clock set back (a negative
  delta) rewrites it at once, and a reader takes an mtime more than one tick ahead of its clock as old, not fresh. A
  marker counts only while its process exists **and** it was refreshed within three beats (`STALE_AFTER_MS`), so one
  left by a crash or a reboot goes stale even when its process id has since been given to another process. An old
  marker whose process exists is read again after `SETTLE_MS` (10 s, five ticks, the longest a check waits): a holder
  that just woke has written it by then, and a marker that is fresh or whose holder or mtime changed counts as held. One
  still old and unchanged is not counted, and it is left where it is: the next holder overwrites it and the wipe deletes
  it, so until then a check that finds it waits `SETTLE_MS` (desktop startup in the background, a wipe or the CLI's
  `reset-data` with its "checking" status). The desktop app reads the
  CLI marker at startup so it does not clear a login the CLI session is using; that check runs beside the first
  window, which never waits for it, and re-reads the settings before clearing, so a login made meanwhile is kept. The
  wipe (`wipeLocalData`) refuses to run while anything live is in the way and touches nothing, answering the code of
  what it found, in this order: `busy-cli` (a live CLI process holds its marker), `busy-app` (the desktop app holds its
  marker — what the CLI's `reset-data` and the web shell see), `busy-web` (a `pnpm web` server holds its marker) or
  `busy-pass` (a voting pass runs in this process). The markers are read together (one
  wait, not two) and the pass is asked last, synchronously, right before the files go, so a pass that began during
  the wait is refused too. A saved "auto-vote running" flag is only a wish to resume at the next start and does not
  block. The delete modal words each code with its own next step (stop the CLI session in its terminal / quit the
  desktop app / stop the web server / stop auto-vote); any other failure reads as the generic "not everything was
  deleted". The wipe deletes the files the settings are restored from (`settings.json`, `settings.json.original`,
  `v2-import.json`) before `config.json`, and keeps `config.json` when one of them cannot be removed, so the next load
  never restores a sign-in from a mirror that was left behind; a removal that fails on a busy file is retried. On
  Electron it clears the storage and cache of the app's windows and of Electron's default session (its files sit at
  the user-data root). After a successful wipe Electron and Android relaunch; the web shell's server stops, so its text says to
  start `pnpm web` again (`usePlatformCapabilities().relaunchesAfterWipe`, read from the flag the web bridge sets).
- Write-behind is **ordered** (writes chain onto a promise) and `flushPendingWrites()` awaits durability
  before session invalidation. On Capacitor, `initializeAsync()` must be awaited before the first sync
  read — **each store hydrates independently**, so a new store must be wired into the Capacitor bootstrap
  (`react/pages/Capacitor.tsx`) or its markers are invisible after relaunch. `joinState` is wired there
  alongside settings + metadata; skipping it would double-charge a paid retry on Android.
- Platform detection has two sides: **node-side** via `runtime.ts` (`isCapacitor()`, `isHeadlessService()`,
  `getPlatform()`, `getAppUserDataPath()` — the single path resolver shared with the logger); **renderer-
  side** via `globalThis.Capacitor?.isNativePlatform?.() === true` inline, to keep node out of the browser
  bundle.
- **The Electron main process runs from a bundle.** `scripts/build-main.ts` bundles `src/ts/index.ts` into
  `out/main/app.js` with a linked source map, loaded by the `out/main/index.js` stub (package.json `main`)
  that turns source maps on first so main-process stack traces point at `src/ts`. Every package import stays
  a runtime require from the shipped `node_modules`; `src/ts` itself is not packaged, and `out/` stays out of
  `dist/` (Capacitor's webDir, which ships in the APK). Inside the bundle every module shares the bundle's
  `__dirname`, so paths to the app's own files (HTML pages, preload bundle, assets, the dev model cache) come
  from `appPath(...)` (`appPaths.ts`), which resolves the root as `__dirname/../..` — valid because the bundle
  sits at the same depth below the root as `src/ts/`.

## 8. Renderer / UI conventions

- **All backend calls go through `window.api.*`** — there is zero Electron-vs-Capacitor branching in
  components. Build on the shared envelopes: `react/api/useIpcQuery.ts` (data/loading/error + stable
  `refetch`, optional subscribe) and `react/api/useAsyncIpcAction.ts` (loading + `{success,error}`
  handling). `useSettings`, `useActiveChallenges`, `useAuth`, `useBoost`, etc. all build on these. One-shot
  calls, event subscriptions and best-effort logging go through `react/api/ipc.ts` (`logRendererError` never
  throws). Nothing else under `src/ts/react/` touches `window.api`; Oxlint enforces it.
- **Settings changes reach every window.** A successful `set-setting` / `save-settings` broadcasts
  `settings-changed` to every open window (Electron) or the in-process bus (Capacitor); `useIpcQuery`
  subscribers refetch in the background without toggling `loading`, and the translation provider reads
  `language` straight from the payload.
- **No router.** "Pages" are separate mount entry points chosen by auth state: `mountApp()`
  (`react/pages/App.tsx`) / `mountLogin()` (`react/pages/Login.tsx`). Electron swaps native windows; Capacitor swaps React trees into `#root`.
- **No toast library.** Error surfaces are: inline DaisyUI `alert` banners with a translated message; and
  `react/components/ui/ErrorBoundary.tsx` (an `alert alert-error` with Dismiss/Reload) wrapped around every
  major subtree. Action failures generally log via `ipc.logRendererError` rather than showing a banner.
- **Error-message content quality (UX).** User-facing error text follows _what happened → why → what to do
  next_, uses a translated string, and **never** dumps raw HTTP status codes or internal result shapes at
  the user — internal detail goes to `logError`, not the UI.
- **Reuse the `react/components/ui/` primitives** rather than re-rolling: `Modal` (+`ModalActions`),
  `AsyncActionButton`, `StatusBadge` (+`ConnectionBadge`), `LoadingSpinner`,
  `ResetButton`. New modals **must** go through `ui/Modal.tsx` — it owns the a11y bar:
  `role="dialog"` / `aria-modal`, a full Tab/Shift+Tab focus trap, focus-move-in on open and restore on
  close, Escape-to-close, and body-scroll lock. Modals stack: only the topmost open one answers Escape and
  Tab (the photo chooser opens from inside a settings modal), and the scroll lock holds until the last closes.
- **Theme** = a `data-theme` attribute on `document.documentElement`, sourced from the `theme` setting
  (DaisyUI). There is **no `dark:` Tailwind variant** in the codebase — theming is entirely `data-theme`.
- **High-frequency updates** use `@preact/signals` (`react/hooks/useTimers.ts`): a single 1 s interval
  mutates `signal.value` in place so the challenge list does **not** re-render every tick. `useTick` is the
  shared per-second wall-clock re-render.
- The same tree runs under Electron Chromium, the Capacitor WebView, and happy-dom in tests — so code
  deliberately avoids Node-only APIs in favour of `window.api`, `CustomEvent`, and signals (see the note in
  `react/contexts/AutovoteContext.tsx`), which behave identically across all three.

## 9. i18n

- **User-facing strings are mandatory-translated.** They come from `useTranslation().t('namespace.key')`;
  raw literals in JSX are effectively absent. Add every new key to **both** `translations/english.ts` and
  `translations/latvian.ts`, under the existing namespaces (`common` / `errors` / `onboarding` / `menu` /
  `login` / `app` / `logs`). Languages: `en` and `lv` only.
- **Internal / log / error-prefix strings stay English** (not translated) — e.g. the fallback strings
  inside `useAsyncIpcAction.ts` and the action hooks are English literals by design.
- Non-hook contexts (class components, primitives, the deadline notifier) use the bundled
  `translations/renderer.ts` translator (`ui/Modal.tsx`, `ui/ErrorBoundary.tsx`), because they can't call
  the hook. The dependency-free core is `translations/translator.ts`; the renderer persists the language
  through `window.api`, the Node side (`translations/index.ts`) through the settings facade.

## 10. Security (renderer / main) — state the limits, don't over-promise

- The login and main windows set `contextIsolation: on`, `nodeIntegration: off`, `webSecurity: on`
  and `sandbox: on` explicitly (`index/windows.ts`, after any caller-supplied preferences so a caller
  can't override them). The Logs window (`ui/applicationMenu.ts`) sets `contextIsolation`,
  `nodeIntegration` and `sandbox` explicitly and relies on Electron's default for `webSecurity`; the
  menu keeps one reference to it, focuses it when open and clears it on `closed`. The renderer is exposed only `window.api` via `contextBridge`, never
  `ipcRenderer`. Regressing context-isolation / node-integration / sandbox is a classic severe-vuln class.
- A defense-in-depth **sender-frame trust check** (`isTrustedSender`, `ipc/registerHandlers.ts`) has
  these rules: no Electron event at all (a direct call from the CLI, Capacitor, the web shell or a
  test) is trusted; an event with no `senderFrame`, or a frame whose `url` is not a string, is refused;
  a frame that is not the window's main frame is refused; the main frame is trusted only when its URL
  starts with `file://`; anything that throws while being inspected is refused. It does not check that
  the file lies inside the app, so a packaged or portable layout can't lock itself out — the navigation
  guard below is what keeps a window on the app's own pages. The check is reused by the manual
  `ipcMain.on` channels, and its refusal log line carries the sender URL.
- **Logs window** (`ui/applicationMenu.ts`): it loads its own sandboxed preload, `dist/preloadLogs-bundle.js`
  (`preloadLogs.ts`), built from the same `preloadApi.ts` helpers as the main preload but from the manifest's
  `logsWindowInvokeChannels` (`get-setting`, `log-error`, `get-log-backlog`, `start-log-stream`,
  `stop-log-stream`) and `logsWindowEventMethods` (`onLogMessage`, `onSettingsChanged`) only — no spend, no
  settings write, no other log channel. The main process enforces the same set per sender, whatever the
  preload exposes: the menu registers the window's `webContents` with `restrictToLogsChannels`, and
  `registerHandlers` refuses any other invoke from it (`isChannelAllowedForSender`), next to `isTrustedSender`.
  Its settings read is language-only: `get-setting` from that window answers only the `logsWindowSettingKeys`
  (`isSettingKeyAllowedForSender` refuses any other key), and the `settings-changed` events the main process sends
  it are cut down to the same keys, so the window learns the language and nothing else about the settings.
  `restrictToLogsChannels` filters only `webContents.send`, so the `frame-guard/no-unfiltered-frame-send` lint rule
  (`scripts/lint/frame-guard.mts`) keeps frame handles and every other send out of `src/ts`.
  The rule catches accidental frame-handle use and unfiltered sends; deliberate obfuscation (reflection such as
  `Reflect.apply` or `Function.prototype.call.call`, aliasing `webContents.send` and rebinding it, computed keys
  from variables) is out of its scope. The runtime guarantee is the Logs window's reduced preload, which exposes
  no listener for any other channel, plus the per-sender channel check in the main process.
- **Navigation guard** (`index/navigationGuard.ts`, registered in `index.ts` on `web-contents-created`
  so it covers every window): no window opens another — `setWindowOpenHandler` always denies, and hands
  the URL to the system (`shell.openExternal`) only when `isOpenableLinkUrl` (`format/urlSafe.ts`)
  accepts it: `https:`/`http:` without userinfo, or `mailto:`. `will-navigate` and `will-redirect` let a
  window stay on its current URL (reload) or move to an app page (`isAppFileUrl`, `appFileUrl.ts`: a
  `file:` URL below `src/html`, compared with the platform's path rules — case-insensitive on Windows,
  another drive or a UNC share rejected); any other target is cancelled and then opened externally if
  openable, else logged as refused. Challenge `welcome_message` links (`sanitizeWelcomeMessage`) rely on
  this: they never load in an app window.
- **Permission handlers** (`index/permissions.ts`, installed in `onReady` before the first window): on
  the default session and on the in-memory app session `gurushots` (`APP_PARTITION`, `index/session.ts`:
  no `persist:` prefix, so its cookies, storage and cache never reach the disk; a stale on-disk partition
  directory is removed at startup), only `notifications` is granted (the deadline
  notifier), and only when the requesting `webContents.getURL()` starts with `file:`. Checks are judged
  on that URL, never on `requestingOrigin` (always `file:///` for a file page), and a check with no
  web contents is denied. Every denial is logged.
- **CSP**: every renderer page carries a policy with `object-src 'none'`, `form-action 'none'` and
  `img-src 'self' data: https://photos.gurushots.com`, and a build test fails on a missing policy or an inline
  script. The Electron pages (`app.html`, `login.html`, `logs.html`) and the web shell page use
  `connect-src 'self'`: the renderer makes no fetch/XHR to a remote host (all network calls run in the
  main process). The Android pages (the Capacitor page and `headless.html`) run network code in the WebView,
  so their `connect-src` also allows `https://api.github.com` and the photo CDN, and their `script-src`
  adds `'wasm-unsafe-eval'` for the vision runtime.
- The settings files (`config.json`, its mirror `settings.json` and the copy `settings.json.original`) are written
  mode `0o600` — but **only at creation. A pre-existing or backup-restored file keeps whatever mode it already
  had** (the source says as much); don't state 0600 as an always-guarantee. The renderer never receives the `auth`
  block of the configuration, only `hasToken` (§7).
- **Log redaction (`logger/sanitize.ts`, through the `logger.ts` facade) is two-layer but credential-key-keyed, not exhaustive.** `sanitizeForLog`
  recursively redacts an **allowlist** of sensitive object keys; `redactMessage` scrubs
  `token=…` / `password=…`-style fragments folded into message strings. Both run on every entry, and
  untrusted API strings additionally pass through `logger.sanitizeLogString()` before interpolation. The
  allowlist covers the literal `x-token` header key the join/bankroll WEB endpoints send, but it is still
  an **allowlist** — prefer never logging a raw headers object rather than
  relying on it — and neither layer is **PII-aware** (e.g. a username logged into a message is not
  redacted).
- **Console-only printers** (`logger/write.ts`, through the `logger.ts` facade) are for output a CLI
  command is asked to show, never for the log files. `printLine` and `printStderr` redact like the
  log; `printLine` keeps the line breaks. **`printDocument` does not redact**: it prints a document
  the user asked to see or pipe verbatim, because redaction would corrupt it (the scenario JSON). It
  only strips terminal control — ANSI sequences, control and invisible format characters — so use it
  only for a document that holds no credentials, and escape the JSON first (`escapeTerminalUnsafe`,
  `format/logSafe.ts`) when the same text is also written to a file.

### Accepted limits

These are known and deliberate; don't describe the app as stronger than this.

- **The login token is stored in plaintext in the settings store, in two places.** On desktop and the CLI it is in
  the `auth` block of `config.json` and, because `settings.json` mirrors the configuration for older builds (§7), a
  field of `settings.json`, both in the app data folder, files created owner-only (`0o600`); on Android they are
  `@capacitor/preferences` entries (`gurushots-config`, `gurushots-settings`) in app-private storage, excluded from
  cloud backup and device transfer (`data_extraction_rules.xml`). `settings.json.original` (the file the user had
  before the first mirror write) and the copies set aside of a settings file (`config.json.corrupt-<time>`,
  `settings.json.unimportable-<time>`) can hold a token as well until the next logout, which clears it from every one
  that parses (one that does not parse is left as it is). A sign-out made in an older build is taken over at the
  next start (§7), so an older build cannot leave the sign-in in the mirror either. It
  is not encrypted because the Node CLI shares the files with the GUI and cannot read Electron `safeStorage`, and
  macOS runs Chromium on a mock keychain on purpose (`use-mock-keychain`, `index.ts`), so `safeStorage` would add no
  real protection there. Anything that can read the owner's files, or run as that user, can read the token; logging
  out removes it from all of them (a mirror write that fails is retried, and the next save or start makes it), and
  so does "Delete all local data".
- **Desktop builds are not signed by a publisher** (no Developer ID or notarization on macOS, no publisher
  certificate on Windows). The update trust root is therefore write access to the project's GitHub releases: the
  update check and download go to `api.github.com` and GitHub release downloads, branches and tags are
  protected, but a stolen maintainer token could still publish a build. Android APKs are signed in an isolated
  release job with a pinned certificate, and that job refuses any other.
- **`[skip ci]` anywhere in a commit message skips CI.** GitHub reads the marker from the whole message, not only
  the subject, so a commit that carries it (the release's own version-bump commit does, on purpose) is not built
  or tested. Review such a commit by hand.
- **The Android background service is a `specialUse` foreground service** (`AutoVoteService`, subtype declared
  in `AndroidManifest.xml`): unlike `dataSync` it has no run-time cap. The app is sideloaded, so Play's review of
  that service type does not apply, and the app is not offered on Google Play.

## 11. User-defined scenarios

A **scenario** is a user-written, multi-day playbook for a challenge: named **phases**, each with a
**settings overlay** and ordered **rules** (`if` conditions → `do` actions, a `repeat` mode). The app
hard-codes no tactic; `scenarios/vocabulary.ts` is the one list of conditions, entry selectors, actions and
caps (dependency-free, renderer-safe), and `scenarios/templates.ts` holds editable examples.

- **Documents** (`settings/scenarios.ts`, `settings/scenarioSchema.ts`, via the facade): stored name-keyed
  in `challengeSettings.scenarios` (so the Android background service has them) and re-validated on read.
  A shared file is untrusted input: size-capped before parsing, strict zod shapes (unknown keys rejected),
  bounded non-reserved names, resolvable `start` / `goto` / memory slots, and phase settings limited to
  per-challenge keys validated like profile values — with paired keys (`exposure`/`exposureTarget`,
  final-window trigger/target) set together, because `getEffectiveSetting` does not re-validate combined
  values. Rename and delete cascade to every assignment.
- **Assignment** is the `challengeOnly` setting `scenario` (per challenge, challenge rule inline key, or
  profile). An unknown name runs nothing and is logged.
- **Overlay precedence**: while a challenge is in a phase, that phase's `settings` sit **above** every other
  layer of `getEffectiveSetting` for that challenge, the manual override included
  (`settings/scenarioOverlay.ts`). Leaving the phase restores normal values; nothing is copied into stored
  overrides; the `scenario` key itself is never overlaid. No overlay while the state is unreadable, belongs
  to another scenario, or names a phase the scenario no longer has.
- **Runtime state** (`scenarioStateStore.ts`, per challenge: phase, memory, fired markers, in-flight action,
  spends, last action/error). An unreadable file or malformed record reads as **corrupt, never as a fresh
  start** (an empty file included: the file is written whole by temp file, flush and rename, so an empty one was cut
  short, never "no state") — the challenge halts, because replaying a plan could repeat spends, and the file is never replaced by one
  challenge's change: a reset of one challenge on an unreadable file answers `state-unreadable`, and only a reset
  of every challenge (`reset-all-scenario-state`, CLI `scenario-reset --all`, the card's "Reset every challenge's
  progress…") clears it, with the warning that every challenge's progress, repeat protection and spend counters
  go; a spend count must be finite and not negative; every `fired` entry and every `unclear` / `unclearHalt` marker must be a plain record and a spend action to
  be trusted. One process runs a challenge's rule steps at a time: the step takes the cross-process lock
  `scenario-<id>` (the unlock lock's machinery) before it reads the state and spends, and a challenge whose lock
  another process holds is skipped for that pass (the pass is given the lock, so mock mode, which has no other process and must never
  touch real files, has none). Every change of the file is read-modify-write of the whole, so it is made under a
  second cross-process lock (`scenariostate`, a bounded wait of half a second, the file read again under it);
  when the lock cannot be had, or the write fails, the change is not made and the runner stops the rule there. A
  read never writes, waits or takes a lock. **A spend is written down before it is made**: a currency spend
  (swap, unlock a boost, fill) persists `inFlight.pending` for its step inside the spend path itself
  (`lockedCurrencySpend`), under the spend lock and just before its request, after everything the scenario itself
  can refuse it on (the memory slot, the limit, the reserve, a busy spend lock): a spend that is refused there
  leaves no marker, and one whose marker could not be written is not made (the step is deferred). If the result of the
  spend is then never written (the lock was busy, the disk failed, the process died, the one-shot CLI exited), the
  next run in any process finds the marker and treats it like `unclear`: it looks at the live challenge, goes on only
  when that positively shows the spend landed, and otherwise stops the rule (the notice says the app did not record
  whether it was sent or what came of it, `haltOrigin: 'pending'`, not that GuruShots gave no answer; a marker that is
  absorbed keeps that origin in `inFlight.lost`); it never spends again. A spend recovered
  from `pending` is counted in `spent` when it is recovered (a spend that got no answer is counted when it is
  marked, and not twice), so the scenario's limits hold across a crash. The markers are per spend: `unclear` is a
  list of action types, so an edit of the step never overwrites one with another; a `pending` marker the step now
  running is not for (the edit) is counted and kept as `unclear`, also when the step is not a spend, so reverting the
  edit never spends it. The result of a step is written down, and written once more if that fails, before it is given
  up on (a short hold of the lock after a spend that landed must not stop a rule for good); when it still fails the
  log says the next pass may stop the rule needlessly. Nothing is kept in memory: the file is what protects a spend.
  **What gives that guarantee, by platform**: Electron and the CLI write the file synchronously through a temp file,
  fsync and rename, under the cross-process lock, so a write that returned is on disk. The Android background
  service writes through the native bridge, whose `writeKey` now commits synchronously and answers whether it
  persisted (a refused key, a value that is no JSON, a failed commit, or no answer at all throws in the store, so
  the marker is not taken as written, and a failed write is never read back); a write that returned there is on disk. The Android app's WebView does not give it: its
  writes go to `@capacitor/preferences` behind a cache and return before they are persisted, so a crash right after
  can lose a marker; the app does not run scenarios while the native service is available, and where the WebView
  does run them (no service) the marker is best effort. Mock mode keeps everything in memory.
  **Resets are counted**: the file keeps a count of resets of every challenge (`@all`) and each challenge's
  record (a tombstone, for a challenge reset away) keeps its own; a state carries the counts it was read under
  (`epoch`) and a write of a state read under older ones is refused, so a step that was running when its challenge,
  or every challenge, was reset cannot bring the old progress back, in this process or another, and with no lock
  to rely on (the Android service has none). The refused step stops, and says it was reset. On Android the app does
  not rewrite the file from its cache for a reset (the service may have written it since): it writes the reset into a
  store of its own, `gs_scenario_resets` (`{ "<challengeId>": count, "@all": count }`, a side key of the native
  bridge), and the reset is applied, idempotently, by whichever runtime reads or writes the state file next (the app's
  own reads apply it as well); the request is **written through**: it waits its turn in the store's write queue, is made from the cache as it is then, and goes into the cache only once Preferences has it (`createJsonStore().updateThrough`), so a reset that could not be saved (`not-saved`) changed nothing, and no read, refresh or engine pass ever saw it. The same holds for the reset of every challenge on a file that cannot be read (its one direct write). A queued write puts down `intended` on its turn, the latest value queued or written through (no refresh changes it), so one built before a write-through landed cannot overwrite it; and a write queued while a write-through is being saved is rebased onto it, so both changes are saved.
  A request ages like what it asked for (its count is when it was asked): one older than 30 days is ignored, so it
  cannot make a pruned tombstone again, and the app drops it when it next asks for a reset; an unreadable file has nothing to lose and is cleared by the app itself. A progress
  that cannot be read is `file` (all of it: only the reset of every challenge, `reset-all-scenario-state`, clears it)
  or `record` (this challenge's: its own reset does; a write of another challenge keeps it until then, only valid
  records and tombstones age out). A record that still holds a spend marker or a stopped rule (`unclearHalt`) does not
  age out either, until it is reset: it is small, and an unattended stop is for the user to look at. A reset takes the challenge's step lock and answers `busy` when that or the file's
  lock is held (by the app's own pass or by another process), never a silent success, and `locks-unavailable` when the
  app cannot create its lock files at all (the app's own locks fail closed and say so, and are logged as errors with
  the path and the error code, so `logs --error` shows them: the dialogs and the CLI send
  the user to the data folder's permissions and the free disk space, and the runner warns every pass, where a lock
  merely held is a debug line until it persists for three); the reset of every challenge takes no step locks, the
  counts make them unnecessary. Every card reads its status again after a reset (`refreshScenarioStatuses`). The
  card's notice for a rule stopped after
  a spend that got no answer says when that rule can run again by its repeat (the phase entered again, a reset, the
  next day), points at the card's Reset button (a dialog that carries the cost: it can spend the unanswered action again and
  restarts the spend counter) and at `scenario-reset --challenge=<id>` in the CLI, and shows a later problem
  beside it, for a rule being checked on too (`inFlight.unclearAt` against `lastError.at`); the compact tile gets a
  short notice, whole, that begins with the control to press ("Details"). Mock
  mode uses the in-memory ledger. Android persists it through the native keyed bridge
  (`gs_scenario_state`); the app WebView `refreshAsync`es it before status reads, resets and each in-app
  pass, and when the native service is available only the background service advances scenarios
  (`backgroundServiceOwnsScenarios`, `services/scenarioRunner/step.ts`).
  **Not loaded** (`corrupt: 'unloaded'`, a third kind beside `file` and `record`): a store whose read failed holds
  nothing known, and is never read as empty — a plan restarted from nothing could spend again. In the app window the
  start-up read of `gs_scenario_state` or `gs_scenario_resets` can fail (`isCacheKnown`, `scenarioStateLoaded`); in the
  headless service a read through the bridge that threw reads the same (`headlessReadFailed`; a missing key answers the cache,
  a throw is a failure, and so is a strict store with no bridge). While it holds, `read()` answers unloaded: nothing is
  written, nothing is reset (`state-unloaded`), the plans of that process pause, and the card offers no reset. The card
  words it by who owns the plans: where the background service is installed (`serviceRuns` in the status payload: it
  owns scenarios, which is not the same as running at this moment) only this window lacks the progress and the card says
  the service runs the plans from its own copy if it is running, without it the plans are paused. The service's own
  pause (a failed read in its context) is not shown by the app yet: it lives in the service's headless WebView, whose
  logs do not reach the app's log views on a release build, and it ends at the next successful read. The app window's pass
  re-reads (`refreshScenarioStateAsync`) before running while the cache is not loaded, whoever owns scenarios. A reset
  of every challenge that the dialog offers for unreadable progress is asked for `onlyIfUnreadable`: decided on the file
  as it is where the write is made (under the lock, or when the write's turn comes), a file that reads again is left
  alone and the answer is `state-readable`. A strict store's cache keeps a queued write that did not persist (a spend
  marker), and a refresh does not replace it with the older stored value until a queued write persists.
- **Automatic fills** (`currencyAutoStore.ts`, `services/currencyAuto.ts`): the count of fills spent per challenge
  (`gs_auto_spends`, what `autoExposureFillMax` caps) is persisted by the Android service through the bridge, like the
  scenario state, in the one `CapacitorStorage` file the app window also reads. The count is written down **before**
  the fill (`reserveFill`): a write the bridge refused means no fill, a fill that was refused and never made is given
  back, and one that got no answer stays counted. A ledger that cannot be trusted (a store that could not be read, a
  value that is not a JSON object) counts as unboundedly many, is logged once and is never written over, so no fill is
  spent against a count that is not known. A record older than 30 days does not count.
  With the background service the app window leaves the automatic joins (`runJoinPass` is skipped) and both kinds of
  fills (`fillsLeftToService`: the exposure rule's and a mission's) to it, and says so in the log when one of those
  settings is on. Two loops would count down and overspend separately.
  **Claims are changed by compare-and-set.** The paid-join claims (`gs_join_state`) can be changed by both contexts
  that pay: the service through its bridge (`compareAndWriteKey`), the window through the plugin (`compareAndWrite`).
  Both go into one process-wide synchronized compare-and-set on the side stores (`SideStores` in `AutoVoteService.kt`;
  the service runs in the app's own process): a value is saved only if the key still holds what the writer read, and
  is one JSON object of at most 256 KiB. A change (`updateThrough` on a `shared` store) reads, decides on what is
  stored, saves, and on a mismatch reads again and decides again (5 attempts, then it is not saved). So exactly one
  context records the claim of a challenge, and nothing is paid before the claim was saved. A decision that only reads
  (is this challenge paid for?) re-reads the claims first, and a paid one refuses when that fails. A build without the
  plugin has one writer and keeps the write-behind.
  The swap-back ledger (`gs_swap_backs`) still has two writers, and losing an offer is harmless by design. The other
  service stores can stay unpersisted: `gs_entry_ages` only times a boost (a lost age never holds one) and remembers a
  submitted photo, and `gurushots-metadata` and `gurushots-photo-stats` hold last-vote times and statistics. None of
  them guards a spend.
- **Engine** (`scenarios/conditions.ts`, `selectors.ts`, `evaluate.ts`, `nextWake.ts`, pure): unknown data
  fails closed (never makes a condition true); entry ids are compared as strings, never by position (except
  the explicit `slot` selector); an in-flight rule resumes first; a phase or in-flight rule the edited
  scenario no longer has **halts** the challenge instead of guessing.
- **Runner contract** (`services/scenarioRunner/{step,rule,actions,support}.ts`, first step of `processChallenge`, never throws): the
  challenge is re-read live and the action's entry re-resolved before every action; a gone target skips the
  action. Once one action of a rule lands the rule is **committed** and its progress persisted after every
  action, so a crash never repeats a spend that landed. A committed rule then passes over a **skipped** step
  (target/precondition gone — a permanent state such as the boost already used) and carries on, keeping it as
  the last problem, while a **failed** or deferred step (a transient refusal: API failure, unreadable balance,
  busy lock) resumes at that step next pass. A step whose spend got **no answer** is marked `unclear` on the
  rule's `inFlight` record itself (so editing the scenario and reverting never forgets it) and is never spent
  again: the retry only reads the live challenge. When it cannot show the step took effect, the rule is
  recorded as fired with `unclearHalt`, and a rule that repeats every pass is also held back (`repeatBlock`)
  until its phase is entered again; the status line says "unclear, will be re-checked" or "unclear, rule
  stopped" from that state. A rule whose first action does not go through simply did not
  fire, so a skip never uses up a `once` rule. A `goto` takes effect when the rule finishes. No spend cap: each rule
  fires at most once per pass and a `goto` chain stops on revisiting a phase in that pass; spends honour the
  user's `currencyReserve*` (shared `reserveAllows`) and the scenario's optional `limits`.
- **Vote speed** (`scenarios/speed.ts`): the runner samples every entry's votes once per pass into the state's
  `history`, keyed by photo id (a swapped-out photo keeps its history). `votesPerHour` / `speedRatio` and the
  `fastest` selector read it; a speed with under 10 minutes of history, or nothing to compare with, is null and
  fails closed.
- **Notices** (`services/scenarioNotifications.ts`, pure): a `notify` action — and a halt — appends to the state's
  bounded `outbox`; each host's per-cycle notifier (CLI `nodeNotify.createNodeScenarioNotifier`, desktop
  `react/notifications/scenarioNotifier.ts`, composed with the deadline notifier) shows only notices created
  after it started, each once, gated by `notifyOnScenario`. Native Android delivers none, as for deadlines.
- **Simulation** (`scenarios/simulate.ts`, pure): a what-if timeline jumping between the engine's own wake-ups,
  chaining rules like the runner; assumes every step succeeds and live data holds still, and says why it stopped.
  IPC `simulate-scenario` (stored scenario, or an unsaved draft via `settings.checkScenario`), CLI
  `scenario-simulate`, and the builder.
- **Builder** (`react/components/app/scenarioBuilder/`): forms generated from `scenarios/builderSpec.ts` (every
  condition / action / selector's fields and kinds — a test checks every default against the validator) over
  pure draft edits in `scenarios/builderModel.ts`; it never validates itself — save and simulate do.
- **Surfaces**: IPC `ipc/scenarios.handlers.ts` (the CLI reuses it), CLI `cli/commands/scenarios.ts`,
  GUI `ScenariosSection` (+ the builder), the `scenario` field in `SettingInput`, and the card
  `ScenarioStatusLine`.
