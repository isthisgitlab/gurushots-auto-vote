# Architecture & invariants (developer reference)

This is the deep reference behind the terse invariant bullets in `CLAUDE.md` / `AGENTS.md`. It documents
the application's own conventions — the voting engine, scheduler, API transport, IPC surface, persistence,
renderer, i18n, and security — the things a contributor (human or agent) must not break but that the code
alone doesn't spell out. For the three per-platform timer engines, see the companion `scheduling.md`.

**Citation convention.** Each reference leads with the **symbol/function name**; any line number is a
*secondary hint* ("around L204"), because this repo has high edit velocity and bare line ranges rot on the
next unrelated edit. If a number is stale, search by name and update it here.

**Path convention.** Paths are relative to `src/js/`; renderer paths keep their `react/…` segments
(e.g. `react/components/ui/Modal.jsx`).

**Verified as of commit `e21931f`.** If a symbol has moved, trust the name over the line number and update
this file.

---

## Glossary

Domain terms used throughout, in reader's terms:

- **exposure factor** — how much the GuruShots API has shown your photo in a challenge, 0–100%.
- **trigger** — vote *if* current exposure is below this value.
- **target** — vote *up to* this value (the vote loop's ceiling). Distinct from the trigger.
- **auto-fill** — automatically submit new photo entries into a challenge's open slots.
- **boost** — a one-shot exposure multiplier applied to a single entry.
- **turbo** — a timed exposure surge on an entry.
- **flash** — a challenge *type* that is always auto-targeted to 100%.
- **last-minute / last-hour windows** — deadline-proximity windows that change both the cadence and the
  exposure targets.
- **key-unlock** — a boost unlocked by spending a challenge key.
- **emergency window** — a near-deadline override that spends an otherwise-idle boost/turbo/fill so it
  isn't wasted at the buzzer.

---

## 1. Voting decision engine

- `runVotingPass(token, filter, deps)` (`services/votingOrchestrator.js` — around L294) is the **one**
  shared loop for both real and mock strategies. **Never fork it** — a fork re-introduces the real/mock
  drift the shared loop exists to remove. Inject strategy differences via `deps`.
- The per-challenge action **runners are strictly sequential, never parallelised**: auto-fill mutates the
  shared challenge object (`reflectNewEntry`) so a later turbo/boost in the same cycle sees the new entry
  and the consumed slot.
- The decision engine is `_runVotingRules()` (`services/VotingLogic.js` — around L248). Its precedence
  order is load-bearing: onlyBoost → not-started / already-ended → flash (→100) → last-minute window
  (→100) → scheduled-fill window → last-hour rule → normal threshold.
- **Trigger ≠ target, and there are two *different* sentinel families — do not merge them:**
  - `exposureTarget` / `lastHourExposureTarget`: `0` or null means **"target == trigger"** — the rule
    stays **active**, it simply votes up to the trigger value (legacy behavior).
    `getEffectiveExposureTarget()` (`services/VotingLogic.js` — around L209); schema note in
    `settings/schema.js` (around L285).
  - `boostTime` / `emergencyFill` / `keyUnlockedBoostTime`: `0` means **feature off / never auto-apply**.
    See the explicit comment in `getEffectiveKeyUnlockedBoostTime()` (`services/VotingLogic.js` — around
    L552: *"An explicit 0 means 'never auto-apply', matching the 0-is-off convention boostTime and
    emergencyFill already use"*), and `maybeEmergencyFillChallenge()` (`services/autoFill.js` — around
    L936: `emergencySeconds <= 0` → `'disabled'`).
- Magic constants: last-hour window = 3600 s; key-unlock boost default window = 900 s when the setting is
  unusable (explicit `0` still = never).
- Vote submission votes over a **Fisher-Yates-shuffled, de-duplicated** pool (structural termination — the
  older rejection-sampling could loop forever on duplicate ids) and never posts an empty ballot
  (`api/voting.js` — around L59, L155).
- **≤1 boost and ≤1 turbo per challenge, on different entries** — enforced by `pickEntryAvoidingConflict()`
  (`services/VotingLogic.js` — around L690) plus a `reflectEntryFlag` marker. Entry-pick logic lives in
  `VotingLogic` (shared core) rather than in `api/boost.js` so mock mode honours the same rule.

## 2. Scheduling

- `createCadenceChain()` (`scheduling/cadenceChain.js` — around L65) is a single recursive `setTimeout`
  chain — **no cron** — shared by CLI, GUI, and Android headless. See `scheduling.md` for the three timer
  engines that drive it per platform.
- The single cadence decision is `computeNextCycleDelayMs()` (`scheduling/thresholdWindow.js` — around
  L141): modes `last-minute` / `approaching` / `scheduled` / `normal`, with the invariant **never sleep
  past an upcoming boundary**.
- Double-fire guard: a **stale-timer identity check** (`getTimer() !== timeoutId`) ensures only the
  current timer re-arms, so a re-armed/stopped chain can't double-fire. There is no mutex around a
  *running* cycle — safety comes from the single-chain design plus the cancellation flag.
- Cancellation is a **global singleton flag** (`voting/cancellation.js`) checked at multiple checkpoints in
  the pass, and it propagates by **`return`, never `throw`** — precisely so a per-challenge try/catch can't
  swallow it.
- `now` is re-read per challenge (a pass can take minutes, so a single clock would miss windows that open
  mid-pass).

## 3. GuruShots API transport

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

## 4. Semantic / lexicon

- `getSemanticScores()` (`services/semantic/index.js`) ranks **auto-fill candidate photos only — it is NOT
  part of the vote decision.** It returns cosine similarity between mean-pooled word-vector embeddings of
  the challenge theme and each photo's vision labels.
- It **never breaks a fill**: any failure (missing asset, no theme text, no in-vocab labels) resolves to
  `null` and the caller ranks lexically as before.
- `SEMANTIC_MATCH_FLOOR = 43` (`services/photoPicker.js` — around L384) is **build-gated by
  `scripts/validate-lexicon.js`** (a statistical gate: `p99(unrelated) < FLOOR < p25(related)`), **not
  hand-tuned**. Scores below the floor are forced to 0 (sub-floor cosine is indistinguishable from vector
  noise), not merely ranked low.
- Labels must be **stemmed word tokens** — the lexicon has no multi-word keys, so a raw multi-word label
  always misses.

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
  would purge/pollute the user's real `metadata.json`.
- **Fail-soft config parsing** is pervasive: `getScheduledFillState` wraps its whole body in try/catch and
  returns inactive; corrupt window values fall back to the schema default rather than "never in window"
  (which under replace-mode would silently block all voting).
- **Log-injection guard**: API-sourced challenge ids/titles are CR/LF-collapsed via `format/logSafe.oneLine()`
  before interpolation (imported directly, not off the logger, because the logger is mocked in much of the
  test suite).

## 6. IPC contract

- `ipc/manifest.js` is the **dependency-free single source of truth** for the whole `window.api` surface —
  four lists: `invokeChannels`, `aliases`, `sendMethods`, `eventMethods`. Both shells generate from it:
  Electron `preload.js` builds `contextBridge.exposeInMainWorld('api', …)`; Capacitor
  `bridge/capacitor.js` builds the identical surface in-process.
- **Drift is CI-enforced** by `tests/ipc/manifest.test.js` — but **name-level only**: a changed
  argument/return *signature* on a channel present in both shells passes silently.
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

- **Don't hand-roll `fs`.** `createJsonStore({fileName, prefKey})` (`settings/storage.js` — around L237) is
  the reusable three-platform JSON store: sync fs at `userData/<fileName>` (mode `0o600`) on Electron/CLI,
  hydrate-once cache + ordered async write-behind to `@capacitor/preferences` on Capacitor, in-memory only
  on the Android headless service. `metadata.js` is the second consumer.
- Write-behind is **ordered** (writes chain onto a promise) and `flushPendingWrites()` awaits durability
  before session invalidation. On Capacitor, `initializeAsync()` must be awaited before the first sync
  read.
- Platform detection has two sides: **node-side** via `runtime.js` (`isCapacitor()`, `isHeadlessService()`,
  `getPlatform()`, `getAppUserDataPath()` — the single path resolver shared with the logger); **renderer-
  side** via `globalThis.Capacitor?.isNativePlatform?.() === true` inline, to keep node out of the browser
  bundle.

## 8. Renderer / UI conventions

- **All backend calls go through `window.api.*`** — there is zero Electron-vs-Capacitor branching in
  components. Build on the shared envelopes: `react/api/useIpcQuery.js` (data/loading/error + stable
  `refetch`, optional subscribe) and `react/api/useAsyncIpcAction.js` (loading + `{success,error}`
  handling). `useSettings`, `useActiveChallenges`, `useAuth`, `useBoost`, etc. all build on these — don't
  call `window.api` raw in a component.
- **No router.** "Pages" are separate mount entry points chosen by auth state: `mountApp()` / `mountLogin()`
  (`react/pages/App.jsx`). Electron swaps native windows; Capacitor swaps React trees into `#root`.
- **No toast library.** Error surfaces are: inline DaisyUI `alert` banners with a translated message; and
  `react/components/ui/ErrorBoundary.jsx` (an `alert alert-error` with Dismiss/Reload) wrapped around every
  major subtree. Action failures generally log via `window.api.logError` rather than showing a banner.
- **Error-message content quality (UX).** User-facing error text follows *what happened → why → what to do
  next*, uses a translated string, and **never** dumps raw HTTP status codes or internal result shapes at
  the user — internal detail goes to `logError`, not the UI.
- **Reuse the `react/components/ui/` primitives** rather than re-rolling: `Modal` (+`ModalActions`),
  `AsyncActionButton`, `StatusBadge` (+`ConnectionBadge`, `MockStatusBadge`), `LoadingSpinner`,
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
- Non-hook contexts (class components, primitives) route through the `window.translationManager` global
  with an English fallback (`ui/Modal.jsx`, `ui/ErrorBoundary.jsx`), because they can't call the hook.

## 10. Security (renderer / main) — state the limits, don't over-promise

- Every `BrowserWindow` uses `contextIsolation: on`, `nodeIntegration: off`, `webSecurity: on`
  (`index.js`), and the renderer is exposed only `window.api` via `contextBridge`, never `ipcRenderer`.
  **Sandboxing here is Electron's default-on behavior** (unset `sandbox` + `nodeIntegration:false`), *not*
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
  untrusted API strings additionally pass through `logger.sanitizeLogString()` before interpolation. Known
  gaps to keep in mind: the key allowlist does **not** match the literal `x-token` header key (so never log
  a raw headers object), and neither layer is **PII-aware** (e.g. a username logged into a message is not
  redacted).
