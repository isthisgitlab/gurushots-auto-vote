# Architecture & invariants (developer reference)

This is the deep reference behind the terse invariant bullets in `CLAUDE.md` / `AGENTS.md`. It documents
the application's own conventions — the voting engine, scheduler, API transport, IPC surface, persistence,
renderer, i18n, and security — the things a contributor (human or agent) must not break but that the code
alone doesn't spell out. For the three per-platform timer engines, see the companion `scheduling.md`.

**Citation convention.** Each reference leads with the **symbol/function name**; any line number is a
_secondary hint_ ("around L204"), because this repo has high edit velocity and bare line ranges rot on the
next unrelated edit. If a number is stale, search by name and update it here.

**Path convention.** Paths are relative to `src/js/`; renderer paths keep their `react/…` segments
(e.g. `react/components/ui/Modal.jsx`).

**Verified as of commit `e21931f`.** If a symbol has moved, trust the name over the line number and update
this file.

---

## Glossary

Domain terms used throughout, in reader's terms:

- **exposure factor** — how much the GuruShots API has shown your photo in a challenge, 0–100%.
- **trigger** — vote _if_ current exposure is below this value.
- **target** — vote _up to_ this value (the vote loop's ceiling). Distinct from the trigger.
- **auto-fill** — automatically submit new photo entries into a challenge's open slots. User-facing text
  calls this **Auto-Submit** (and `emergencyFill` **Emergency Submit**): to GuruShots players a **fill** is the
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

- `runVotingPass(token, filter, deps)` (`services/votingOrchestrator.js` — around L712) is the **one**
  shared loop for both real and mock strategies. **Never fork it** — a fork re-introduces the real/mock
  drift the shared loop exists to remove. Inject strategy differences via `deps`.
- The per-challenge action **runners are strictly sequential, never parallelised**: auto-fill mutates the
  shared challenge object (`reflectNewEntry`) so a later turbo/boost in the same cycle sees the new entry
  and the consumed slot.
- The decision engine is `_runVotingRules()` (`services/decisions/ruleEngine.js` — around L65). Its precedence
  order is load-bearing: onlyBoost → not-started / already-ended → flash (→100) → last-minute window
  (→100) → **pre-boost fill** (→100) → **voting pause** → scheduled-fill window → **pre-final-window top-up** →
  final-window rule → normal threshold. The **pre-boost fill** (`voteBeforeBoost`, default off) votes to
  **100%** for `voteBeforeBoostLeadMin` (1–59, default 15) minutes before an available Boost is auto-applied,
  so the Boost multiplies a full entry rather than a decayed one — a Boost is one per challenge and is spent
  on whatever the entry has at that instant. The apply instant is not re-derived: it comes from the same
  `boostApplyThreshold` (`voting/boostWindow.js`) that `getBoostThresholdSec` uses, so the fill can never aim
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
      stays **active**, it simply votes up to the trigger value (legacy behavior).
      `getEffectiveExposureTarget()` (`services/decisions/thresholds.js` — around L90); schema note in
      `settings/schema.js` (around L87).
    - `boostTime` / `emergencyFill` / `keyUnlockedBoostTime`: `0` means **feature off / never auto-apply**.
      See the explicit comment in `getEffectiveKeyUnlockedBoostTime()` (`services/decisions/thresholds.js` — around
      L129: _"An explicit 0 means 'never auto-apply', matching the 0-is-off convention boostTime and
      emergencyFill already use"_), and `maybeEmergencyFillChallenge()` (`services/autoFill/emergencyFill.js` — around
      L97: `emergencySeconds <= 0` → `'disabled'`).
- Magic constants: final-window width defaults to 3600 s — the `finalWindowDuration` setting's default
  (configurable 60 s … 30 d); key-unlock boost default window = 900 s when the setting is
  unusable (explicit `0` still = never).
- Vote submission votes over a **Fisher-Yates-shuffled, de-duplicated** pool (structural termination — the
  older rejection-sampling could loop forever on duplicate ids) and never posts an empty ballot
  (`api/voting.js` — around L59, L155).
- **≤1 boost and ≤1 turbo per challenge, on different entries** — enforced by `pickEntryAvoidingConflict()`
  (`services/decisions/entryPick.js` — around L33) plus a `reflectEntryFlag` marker. Entry-pick logic lives in
  the shared decision core (behind the `VotingLogic` facade) rather than in `api/boost.js` so mock mode honours the same rule.

## 2. Scheduling

- `createCadenceChain()` (`scheduling/cadenceChain.js` — around L152) is a single recursive `setTimeout`
  chain — **no cron** — shared by CLI, GUI, and Android headless. See `scheduling.md` for the three timer
  engines that drive it per platform.
- The single cadence decision is `computeNextCycleDelayMs()` (`scheduling/thresholdWindow.js` — around
  L390): modes `last-minute` / `approaching` / `scheduled` / `normal`, with the invariant **never sleep
  past an upcoming boundary**.
- Double-fire guard: a **stale-timer identity check** (`getTimer() !== timeoutId`) ensures only the
  current timer re-arms, so a re-armed/stopped chain can't double-fire. There is no mutex around a
  _running_ cycle — safety comes from the single-chain design plus the cancellation flag.
- Cancellation is a **global singleton flag** (`voting/cancellation.js`) checked at multiple checkpoints in
  the pass, and it propagates by **`return`, never `throw`** — precisely so a per-challenge try/catch can't
  swallow it.
- `now` is re-read per challenge (a pass can take minutes, so a single clock would miss windows that open
  mid-pass).
- **Auto-join is a pre-step of the pass, not a separate schedule.** `runJoinPass` (`services/joinChallenges.js`)
  runs inside the shared `fetchChallengesAndVote` (`strategies/real/index.js` real / `mock/strategy.js` mock) before the
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
  runtime range `minHours`/`maxHours` over `close_time` - `start_time` — and every condition present must
  hold (AND); a rule with none matches nothing, and a runtime condition fails closed when either time is
  unreadable. The pure matcher and the default order live in the dependency-free
  `settings/challengeRules.js` so the renderer can use them too. Runtime exists because entry timing and
  tactics really track how long a challenge runs, and photo count is only an **imperfect proxy** for it: on
  the live account 4-photo defaults run 24h, 2-photo ones 48h and 3-photo ones 72h, yet 4-photo challenges
  also span 72h, 168h and 515.7h — so "4 photos" and "4 photos + at least 168h" are different rules.
- **Resolution cascades per key (`ruleValuesFor` in `settings/ruleResolution.js`).** The matching rules are walked in list order and, for
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
  by condition count, then photo count > runtime > type > tag — so "4 photos + 7 days" > "4 photos" >
  "7 days". The user can reorder freely in the editor or reset to this order; saving keeps the order given.
  The one-time `_challengeRulesOrderedV1` migration applies this order to saved rules and appends the former
  `categoryRules` below them; because the cascade lets a lower rule fill keys a higher one leaves unset, it
  logs a warning for every possibly-overlapping pair where that could newly switch `autoJoin`/`autoFill` on.
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

- **Layering**: `api/` is the transport layer — `api-client.js` plus one thin wrapper per endpoint, importing
  nothing from `services/` (`api/voting.js` still records vote timestamps in `metadata.js`). The real-mode strategy composes those wrappers with the services in
  `strategies/real/`: `index.js` (`fetchChallengesAndVote` with its join/claim pre-steps, manual join, the
  Turbo mini-game), `applyBoost.js` (picks the entry via `pickBoostEntry`, posts it through
  `api/boost.js#boostImage`, flags it `boosted`) and `activeChallenges.js` (coalesces concurrent
  `getActiveChallenges` calls per token and pins first-seen titles via `services/challengeTitlePin.js` on a
  successful fetch only). `apiFactory.js` assembles the real surface from these and selects it or
  `mock/index.js#mockApiClient`.
- All POSTs go through `makePostRequest()` (`api/api-client.js` — around L204). **Contract: it returns the
  response body on success and `null` on ultimate failure — it never throws.** Every caller branches on
  `null`, not on a catch.
- Auth: `authenticate(email, password)` posts form-encoded credentials and returns the token payload
  (`api/login.js`). The token is then threaded **explicitly** from caller to caller and injected as the
  `x-token` header — there is no refresh flow.
- Retry/backoff is centralised: exponential backoff + jitter up to `apiMaxRetries` (default 3). Retryable =
  no-response/network, `ECONNABORTED` timeout, 429, any 5xx; every other 4xx is terminal. Honors a server
  `retry_after` / `Retry-After` (seconds). `MAX_RETRY_DELAY_MS = 30000` — a longer server cooldown returns
  `null` and is deferred to the next scheduler cycle.
- Custom (Android OkHttp) adapters **must** call `finalizeAdapterResponse()` to reject non-2xx — axios
  doesn't post-process adapter results, so otherwise an error body is handed back as "success."
- `fetchFailed` vs empty: `getActiveChallenges` distinguishes an outage from an empty account so the
  scheduler doesn't re-arm as if all is well (`services/votingOrchestrator.js`).
- Join/bankroll endpoints (`api/join.js`, WEB profile): `get_member_challenges` (open/un-joined list),
  `coins_unlock` (spends coins to open a paid challenge — **not** known to be idempotent), `get_bankroll`.
  `getBankroll` normalizes the currency array to `{keys,swaps,fills,coins}` and returns **`null` on failure
  — callers must distinguish that from a genuine zero balance** (the UI renders `—`, the handler returns
  `success:false`). Every dynamic value is `encodeURIComponent`'d into the form body.

### 3a. Reading a challenge title

A title rarely just names its subject, so three rules turn it into something searchable
(`services/photoPicker/title.js`):

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
  what survives: `"Color Hunt: Blue & Orange"` used to yield `[color, hunt, blue]` and drop "orange"
  entirely. An English title puts its subject last (`"Epic Lighthouses"`), so nouns are read
  right-to-left — except participles (`-ing`, length-guarded so "king"/"ring" are not caught), which sink
  to the back because the subject LEADS in `"Cats and Dogs Running"`.

The user-editable `ignoreTitleWords` setting (master → profile → per-challenge) strips qualifiers the
rules cannot know are noise — "Epic", "Dramatic", "Captivating". Matched against the RAW word before
stemming, like `STOPWORDS`, so a user writing "captivating" does not have to know it stems to "captivat".
The default is **seeded, not hardcoded**, so every word is visible and removable; "negative" is
deliberately absent because "Negative Space" is a real subject. It is resolved ONCE in `runFillAttempt`
(and once in `pickJoinPhoto`) rather than threaded from the six sites that read the tag settings — a value
repeated six times is one that gets forgotten at one of them.

### 3b. Tag resolution (auto-fill candidate narrowing)

- **The two search endpoints match differently, and that asymmetry is the whole feature.**
  `get_photos_private?search=` matches a library tag **EXACTLY** (`staircase` → 23 photos, `stair` → 0,
  `stairs` → 0), while `search_autocomplete` matches a **SUBSTRING** of a tag (`stair` → `["staircase"]`,
  `case` → `["staircase"]`, and `stairs` → `[]` because no tag _contains_ it).
- Consequence, and the bug this fixes: a "Stairs" challenge stems to `stair`, the exact search misses, and
  auto-fill falls back to an unfiltered library walk ranked by popularity — an off-theme submission with no
  explanation. `services/tagResolver.js` runs the miss path's terms through autocomplete to recover the real
  tag. **It only runs after the exact search has already failed**, so a fill that works today pays nothing.
- `search_autocomplete` needs `member_id`, which is a member identity — the account's `user_name` or its
  opaque id hash. **An email is rejected** (`Couldn't find username`), and the app logs in with one, so the
  login field is not a usable source: identity comes from `get_current_member_profile` (token-only) and is
  memoised per token in `services/autoFill/memberIdentity.js`.
- Resolution is guarded twice because substring matching is blunt: **bounded backoff** (a missing term is
  retried at most `MAX_BACKOFF_STEPS` shorter, never below the server's own 3-char floor) and **mandatory
  validation** — a candidate is kept only if it is a lexical match for the term or the lexicon puts it on
  theme. Without the second guard, `fac` → `["face","factory","manufacturing"]` would fill a "Faces"
  challenge from a factory photo.
- Both deps are **optional** in `fetchCandidatesForChallenge`; omit either and behavior is exactly the
  pre-resolution fallback. Nothing here can fail a fill. **That optionality is a safety net, not the
  shipping state** — every real path supplies them: `strategies/real/index.js` (the `api:` bundle `votingOrchestrator`
  copies into `fillDeps`, and `joinDeps`), `ipc/actions.handlers.js` (manual Fill Now), and both mock
  bundles. Note `runFillAttempt` rebuilds a fresh deps object for its
  `fetchCandidatesForChallenge` call rather than spreading `deps`, so a dep added upstream must be named
  there too or it is silently dropped for auto-fill, emergency fill and manual fill alike.

## 4. Semantic / lexicon

- `getSemanticScores()` (`services/semantic/index.js`) ranks **auto-fill candidate photos only — it is NOT
  part of the vote decision.** It scores each of a photo's labels against the challenge theme separately and
  keeps the **best** (max-pooling); words WITHIN one multi-word label are still mean-pooled.
- **Both sides pool narrowly, and that is load-bearing.** A photo's labels are a bag in which one or two
  entries carry the theme and the rest are scene furniture, so averaging them measured how _generic_ a photo
  was: a real staircase photo scored 0.389 (under the floor, no credit) while a yoga photo scored 0.583 and
  was promoted as on-theme. Symmetrically the challenge vector comes from `buildThemeKeywords()` — url +
  title only, **never `welcome_message`** — because body prose ("made of wood or stone, with people on them")
  drags the pooled theme off its own subject: same challenge, same tag, 0.94 → 0.25.
- It **never breaks a fill**: any failure (missing asset, no theme text, no in-vocab labels) resolves to
  `null` and the caller ranks lexically as before. `buildThemeKeywords()` returning `[]` — every title word
  was boilerplate or contest cadence, e.g. "Guru of The Week" — is that "no theme text" case, on purpose.
- `SEMANTIC_MATCH_FLOOR = 46` (`services/photoPicker/tiers.js`) is **build-gated by
  `scripts/validate-lexicon.js`** (a statistical gate: `p99(unrelated) < FLOOR < p25(related)`), **not
  hand-tuned**. Scores below the floor are forced to 0 (sub-floor cosine is indistinguishable from vector
  noise), not merely ranked low. **The floor is calibrated per pooling shape** — the validator pools exactly
  as the matcher does, so changing one without re-deriving the other silently admits the noise tail.
- Labels must be **stemmed word tokens** — the lexicon has no multi-word keys, so a raw multi-word label
  always misses.

### 4a. Visual re-rank (on-device image model)

- `rankVisually()` (`services/visionVerifier.js`) runs a bundled, 8-bit quantized **SigLIP** model
  (`zero-shot-image-classification`, `@huggingface/transformers`) over the **top 12 tag-ranked
  candidates** of every challenge. Like the lexicon it only orders photos — it is never part of the vote
  decision. One call site feeds every submission path: `verifyFillPick()` in `services/autoFill/pipeline.js` (auto, emergency,
  manual, and fill-new fills via `runFillAttempt`, plus swaps via `rankCandidatesForChallenge`), and
  `pickJoinPhoto()` for auto-join.
- **Prompts come from the challenge, never a theme list**: `a photo of <subject>` from
  `visualSubjectWords()` (the title subject — series prefix, negated words and `ignoreTitleWords` removed,
  **unstemmed**, and deliberately without `abstractTitleWords`, which reads "leaves" as a verb) plus
  `descriptionLead()` — the first two sentences of `welcome_message`, HTML and the shared rewards text
  stripped. Unlike the semantic theme vector, the description is safe here: SigLIP reads a sentence as a
  sentence rather than averaging its words, and it is averaged with the title prompt, not used alone.
- **It only reorders and never empties a pick.** A photo's fit is the mean logit over the prompts; photos
  more than `ln(10)` below the best fit move behind the rest, and tag/popularity order is kept inside both
  groups. It **abstains** (original order) when the title has no visual subject, when no photo reaches
  `ABSTAIN_LOGIT` for any prompt, or on any load/inference/URL failure. Both thresholds were calibrated on
  16 live challenges (2026-09-24) — re-measure against real shortlists before moving them.
- **Packaging, per shell** — the model is fetched and sha256-pinned at build time by
  `scripts/fetch-vision-model.js`; nothing downloads at runtime (`allowRemoteModels = false`).
    - Electron: `extraResources` → `Resources/vision-model`, native `onnxruntime-node` in `app.asar.unpacked`.
      The Android-only copies under `dist/` and the standalone `onnxruntime-web` package are excluded from
      the asar, and `scripts/afterPack.js` deletes other OS/CPU `onnxruntime-node` binaries.
    - CLI: the build embeds a `pnpm deploy --prod` tree + model as a SEA asset (pruned to the host OS/CPU by
      `pruneVisionRuntime`); `services/visionCliAssets.js` verifies its sha256, extracts it once per version
      into `<userData>/vision/<sha>`, and removes finished copies from earlier versions unless one was marked in use
      within the last hour (an older CLI still running may not have loaded its model yet).
    - Android: `dist/` is the WebView root, so `vision-model/` and the single-threaded ORT WASM files are
      served from it and inference runs on the `wasm` device with one thread.
- **Lite builds** (`build:<os>:lite`, `build:cli:<target>:lite`, `build:android:lite`) ship none of the above:
  `scripts/electron-builder-lite.js` drops `extraResources` and the transformers/onnxruntime/sharp packages,
  `build-cli.js --lite` embeds no runtime asset, and `build-react.js --lite` clears the model and WASM files from
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
- The new-entry tracker (`services/newEntryTracker.js`) compares entry ids as **SETS, not positions** — the
  server reorders `member.ranking.entries` between polls, so a positional diff would force a vote every
  cycle. An empty entries array is **not** recorded over a non-empty baseline (a degraded API response must
  not poison the baseline).
- **Mock/real metadata isolation**: the metadata store is shared and un-namespaced, and mock challenge ids
  never match real ones — so mock mode passes `cleanupStaleMetadata: null` plus an in-memory tracker, or it
  would purge/pollute the user's real `metadata.json`. The join flow follows the same rule: mock passes a
  `null` join-state store and no cross-process lock.
- **Paid-join money safety** (`services/joinChallenges.js`): the order is load-bearing — resolve an eligible
  photo **before** any `coins_unlock` (no photo ⇒ skip, no spend); persist the unlock claim
  (`joinState.json`) **before** the charge so a crash can never let a later pass re-unlock (idempotent
  retry), and if the claim can't be written, don't spend; a per-process in-flight `Set` **plus** a
  cross-process lockfile (`acquireUnlockLock`, real-fs platforms, TTL stale-recovery, fail-open) guard the
  check→unlock→mark section; a corrupt/unreadable join-state **refuses to spend** (fail-safe, not fail-open);
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
- **Log-injection guard**: API-sourced challenge ids/titles are CR/LF-collapsed via `format/logSafe.oneLine()`
  before interpolation (imported directly, not off the logger, because the logger is mocked in much of the
  test suite).

## 6. IPC contract

- `ipc/manifest.js` is the **dependency-free single source of truth** for the whole `window.api` surface —
  four lists: `invokeChannels`, `aliases`, `sendMethods`, `eventMethods`. Both shells generate from it:
  Electron `preload.js` builds `contextBridge.exposeInMainWorld('api', …)`; Capacitor
  `bridge/capacitor.js` builds the identical surface in-process.
- **Drift is CI-enforced** by `tests/ipc/manifest.test.js` — but **name-level only**: a changed
  argument/return _signature_ on a channel present in both shells passes silently.
- Handler shape: every `ipc/*.handlers.js` exports `buildHandlers(deps) → {channel: impl}` **and**
  `register(ipcMain)`. **CLI and Capacitor reuse the same handler modules** (`cli/commands/*.js` lazily
  require `buildHandlers()`) — never write a parallel implementation.
- **Add a channel end-to-end**: (a) add the channel string to the right list in `manifest.js`; (b)
  implement it in the matching `ipc/*.handlers.js` `buildHandlers()`; (c) Electron picks it up
  automatically via `preload.js` + the module's `register()`; (d) ensure the handler module is in
  `capacitor.js`'s spread for the Capacitor build.
- Handlers **never throw to the renderer** — they return a tagged `{ success, error }` object. Shared
  preconditions use a Result guard: `requireAuthToken()` (`services/auth.js`) returns
  `{ ok: true, token, settings }` or `{ ok: false, response }`, and callers do
  `if (!guard.ok) return guard.response;`.
- Handlers explicitly **whitelist** the fields returned to the renderer so internal result shapes don't
  leak (`safeResult` / `safeRaw` in `ipc/actions.handlers.js`).

## 7. Persistence & platform detection

- **Don't hand-roll `fs`.** `createJsonStore({fileName, prefKey})` (`settings/storage.js` — around L239) is
  the reusable three-platform JSON store: sync fs at `userData/<fileName>` (mode `0o600`) on Electron/CLI,
  hydrate-once cache + ordered async write-behind to `@capacitor/preferences` on Capacitor, in-memory only
  on the Android headless service. `metadata.js` and `joinStateStore.js` (paid-unlock idempotency markers)
  are the other consumers.
- Write-behind is **ordered** (writes chain onto a promise) and `flushPendingWrites()` awaits durability
  before session invalidation. On Capacitor, `initializeAsync()` must be awaited before the first sync
  read — **each store hydrates independently**, so a new store must be wired into the Capacitor bootstrap
  (`react/pages/Capacitor.jsx`) or its markers are invisible after relaunch. `joinState` is wired there
  alongside settings + metadata; skipping it would double-charge a paid retry on Android.
- Platform detection has two sides: **node-side** via `runtime.js` (`isCapacitor()`, `isHeadlessService()`,
  `getPlatform()`, `getAppUserDataPath()` — the single path resolver shared with the logger); **renderer-
  side** via `globalThis.Capacitor?.isNativePlatform?.() === true` inline, to keep node out of the browser
  bundle.

## 8. Renderer / UI conventions

- **All backend calls go through `window.api.*`** — there is zero Electron-vs-Capacitor branching in
  components. Build on the shared envelopes: `react/api/useIpcQuery.js` (data/loading/error + stable
  `refetch`, optional subscribe) and `react/api/useAsyncIpcAction.js` (loading + `{success,error}`
  handling). `useSettings`, `useActiveChallenges`, `useAuth`, `useBoost`, etc. all build on these. One-shot
  calls, event subscriptions and best-effort logging go through `react/api/ipc.js` (`logRendererError` never
  throws). Nothing else under `src/js/react/` touches `window.api`; ESLint enforces it.
- **Settings changes reach every window.** A successful `set-setting` / `save-settings` broadcasts
  `settings-changed` to every open window (Electron) or the in-process bus (Capacitor); `useIpcQuery`
  subscribers refetch in the background without toggling `loading`, and the translation provider reads
  `language` straight from the payload.
- **No router.** "Pages" are separate mount entry points chosen by auth state: `mountApp()` / `mountLogin()`
  (`react/pages/App.jsx`). Electron swaps native windows; Capacitor swaps React trees into `#root`.
- **No toast library.** Error surfaces are: inline DaisyUI `alert` banners with a translated message; and
  `react/components/ui/ErrorBoundary.jsx` (an `alert alert-error` with Dismiss/Reload) wrapped around every
  major subtree. Action failures generally log via `ipc.logRendererError` rather than showing a banner.
- **Error-message content quality (UX).** User-facing error text follows _what happened → why → what to do
  next_, uses a translated string, and **never** dumps raw HTTP status codes or internal result shapes at
  the user — internal detail goes to `logError`, not the UI.
- **Reuse the `react/components/ui/` primitives** rather than re-rolling: `Modal` (+`ModalActions`),
  `AsyncActionButton`, `StatusBadge` (+`ConnectionBadge`), `LoadingSpinner`,
  `ResetButton`. New modals **must** go through `ui/Modal.jsx` (around L29–100) — it owns the a11y bar:
  `role="dialog"` / `aria-modal`, a full Tab/Shift+Tab focus trap, focus-move-in on open and restore on
  close, Escape-to-close, and body-scroll lock.
- **Theme** = a `data-theme` attribute on `document.documentElement`, sourced from the `theme` setting
  (DaisyUI). There is **no `dark:` Tailwind variant** in the codebase — theming is entirely `data-theme`.
- **High-frequency updates** use `@preact/signals` (`react/hooks/useTimers.js`): a single 1 s interval
  mutates `signal.value` in place so the challenge list does **not** re-render every tick. `useTick` is the
  shared per-second wall-clock re-render.
- The same tree runs under Electron Chromium, the Capacitor WebView, and happy-dom in tests — so code
  deliberately avoids Node-only APIs in favour of `window.api`, `CustomEvent`, and signals (see the note in
  `react/contexts/AutovoteContext.jsx`), which behave identically across all three.

## 9. i18n

- **User-facing strings are mandatory-translated.** They come from `useTranslation().t('namespace.key')`;
  raw literals in JSX are effectively absent. Add every new key to **both** `translations/english.js` and
  `translations/latvian.js`, under the existing namespaces (`common` / `errors` / `onboarding` / `menu` /
  `login` / `app` / `logs`). Languages: `en` and `lv` only.
- **Internal / log / error-prefix strings stay English** (not translated) — e.g. the fallback strings
  inside `useAsyncIpcAction.js` and the action hooks are English literals by design.
- Non-hook contexts (class components, primitives, the deadline notifier) use the bundled
  `translations/renderer.js` translator (`ui/Modal.jsx`, `ui/ErrorBoundary.jsx`), because they can't call
  the hook. The dependency-free core is `translations/translator.js`; the renderer persists the language
  through `window.api`, the Node side (`translations/index.js`) through the settings facade.

## 10. Security (renderer / main) — state the limits, don't over-promise

- Every `BrowserWindow` uses `contextIsolation: on`, `nodeIntegration: off`, `webSecurity: on`
  (`index.js`), and the renderer is exposed only `window.api` via `contextBridge`, never `ipcRenderer`.
  **Sandboxing here is Electron's default-on behavior** (unset `sandbox` + `nodeIntegration:false`), _not_
  an explicit flag at those lines — a spot-checker won't find the word "sandbox" there. Regressing
  context-isolation / node-integration is a classic severe-vuln class.
- A defense-in-depth **sender-frame trust check** (`isTrustedSender`, `ipc/registerHandlers.js`) refuses
  any invoke from a non-main-frame or non-`file://` origin, and is reused by the manual `ipcMain.on`
  channels.
- The settings/token file is written mode `0o600` — but **only at creation. A pre-existing or
  backup-restored file keeps whatever mode it already had** (the source says as much); don't state 0600 as
  an always-guarantee.
- **Log redaction (`logger.js`) is two-layer but credential-key-keyed, not exhaustive.** `sanitizeForLog`
  recursively redacts an **allowlist** of sensitive object keys; `redactMessage` scrubs
  `token=…` / `password=…`-style fragments folded into message strings. Both run on every entry, and
  untrusted API strings additionally pass through `logger.sanitizeLogString()` before interpolation. The
  allowlist now covers the literal `x-token` header key (added for the join/bankroll WEB endpoints, which
  send `x-token`), but it is still an **allowlist** — prefer never logging a raw headers object rather than
  relying on it — and neither layer is **PII-aware** (e.g. a username logged into a message is not
  redacted).
