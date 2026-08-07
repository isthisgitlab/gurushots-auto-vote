# Voting cycle scheduling

This app runs the voting cycle on three different shells (CLI, Electron,
Android). The **cadence decision** — how long to wait before the next
cycle — is shared via `computeNextCycleDelayMs` in
`src/js/scheduling/thresholdWindow.js`. The **timer engine** that acts on
that decision is per-shell, because each shell has a different process
model. Future contributors should keep the decision shared and resist
re-introducing a separate boundary-switch timer per host.

## The shared cadence decision

`computeNextCycleDelayMs(challenges, now, { resolveThreshold, normalDelayMs,
lastMinuteCheckMinutes, minGapMs, resolveScheduledFill?, timezone? })`
returns `{ delayMs, mode, nextEntry, nextScheduled }`:

- **last-minute**: a challenge is already inside its `lastMinuteThreshold`
  window → fixed `lastMinuteCheckMinutes` cadence.
- **approaching**: the soonest upcoming threshold boundary is closer than
  the rolled random delay → wait is capped to that boundary so the next
  cycle lands on it instead of overshooting.
- **scheduled**: the soonest upcoming scheduled-fill window start
  (see below) is closer than both the random delay and any threshold
  boundary → wait is capped to that start.
- **normal**: otherwise the random delay in `[checkFrequencyMin,
checkFrequencyMax]`.

Every result is floored at `MIN_CYCLE_GAP_MS`. The host rolls the random
delay and resolves `lastMinuteCheckFrequency`/per-challenge thresholds with
its own resolver (sync settings read on Node, async IPC in the WebView).
This is what fixed the bug where the next cycle could sleep past a
challenge's last-minute boundary and start the final voting push late.

### Scheduled fill

Per-challenge scheduled fill (issue #26) lets a challenge be voted to 100%
at chosen wall-clock instants instead of (or on top of) the exposure
threshold. Two time forms, OR'd when both are configured: a recurring
time-of-day (`scheduledFillTime`, interpreted in the app `timezone`
setting via `src/js/scheduling/wallClock.js`, **not** device-local time)
and a one-shot seconds-before-close offset (`scheduledFillBeforeEnd`).

The decision side lives in `getScheduledFillState`
(`src/js/services/VotingLogic.js`): during a window
`[start, start + scheduledFillWindowMinutes]` the challenge votes to
100/100 like the last-minute rule; with `scheduledFillReplaces` on, the
normal and last-hour threshold rules are blocked outside the windows
(flash and last-minute always win, manual voting is unaffected).

The cadence side lives in `soonestScheduledStart`
(`src/js/scheduling/scheduledFill.js`), fed to `computeNextCycleDelayMs`
through a second injected resolver (`resolveScheduledFill`, sync on Node /
async IPC on the WebView) plus the `timezone` scalar — both optional, so
hosts that don't pass them keep byte-identical behavior. The cap lands a
cycle exactly at the next window start; inside the window the normal
cadence covers decay top-ups (once at 100%, eligibility turns off by
itself).

Deliberate semantics and caveats:

- **Stateless**: there is no persisted "already ran" flag. A restart
  inside a window still fills; a window fully missed while the app was
  not running is skipped with **no catch-up** — in replace mode there is
  no threshold fallback either, which the setting description warns about.
- **DST**: around a daylight-saving switch the actual instant of a
  time-of-day fill can shift by up to an hour on the changeover day
  (spring-forward nonexistent times resolve nearby; fall-back ambiguity
  resolves deterministically). Documented in `wallClock.js`.
- **Timezone changes mid-run** take effect on the next cycle: the decision
  path re-reads `settings.getSetting('timezone')` every evaluation, and
  `timezone` is already in the renderer's reload-required list.
- **Fail-soft**: corrupt persisted values (hand-edited settings.json)
  degrade that one challenge's scheduled fill to "off" — the string key is
  type-guarded, numeric corruption coerces to `NaN`-false, an unknown
  timezone falls back to UTC inside `wallClock.js`, and
  `getScheduledFillState` is wrapped in try/catch so the per-challenge
  voting loop can never be aborted by one bad override.

## CLI — runScheduler (single setTimeout chain)

- **Owner**: `src/js/scheduling/runScheduler.js`
- **Started by**: `src/js/cli/cli.js` `start` command
- **Cadence**: one recursive `setTimeout` chain. After each cycle,
  `scheduleNext` calls `computeNextCycleDelayMs` and arms a single timer.
  Normal-mode waits are anchored to the previous cycle _start_ (so the gap
  between starts ≈ the rolled delay); approaching/last-minute waits run
  from cycle completion so the boundary is never undershot. No `node-cron`,
  no separate threshold timer.
- **Lifecycle**: lives as long as the node process. The CLI host owns
  signal handling and process keep-alive; the scheduler is just the
  cadence engine.

## Electron — UI-driven AutovoteContext

- **Owner**: `src/js/react/contexts/AutovoteContext.jsx`
- **Started by**: the Start / Stop button in the React UI (or auto-
  resume on mount when the persisted `autovoteRunning` flag is true).
- **Cadence**: a single recursive `setTimeout` chain (`cycleTimerRef` +
  `scheduleNext`) driven by the same `computeNextCycleDelayMs` decision,
  bound to the async IPC resolver via `autovoteScheduler.js`. No separate
  interval/boundary timer.
- **Lifecycle**: tied to the renderer window. Closing the window stops
  the loop. The persisted `autovoteRunning` flag means a relaunch
  resumes voting without the user re-clicking Start.

## Android — native Foreground Service + AlarmManager

- **Owner**: `src/js/services/NativeAutovoteBridge.js` (JS bridge to
  the custom Capacitor plugin `AutoVoteBackground`).
- **Fallback**: `src/js/services/ForegroundServiceController.js` runs
  the foreground notification only — used when the native plugin is
  not available on a given build.
- **Cadence**: the _timing engine_ is owned by the native plugin (Java
  side), which uses `AlarmManager.setExactAndAllowWhileIdle()` to fire
  cycles even when the WebView process is dead and the device is in Doze.
  The _next-delay decision_ is still the shared one: the headless JS entry
  (`src/js/headless/index.js`) runs one cycle per alarm and reports
  `nextDelayMs` from `computeNextCycleDelayMs` back to the plugin, which
  schedules the next alarm accordingly. The JS-side `AutovoteContext` cycle
  still runs while the app is open so the user gets immediate visual
  feedback (cycle counter, last-run timestamp).
- **Lifecycle**: independent of the WebView. Survives swipe-to-close.
  Only stopped explicitly via `nativeAutovote.stop()` or by
  vendor-specific battery killers (Samsung / Xiaomi / OnePlus may kill
  the foreground service; first-launch onboarding should prompt the
  user to whitelist the app per-vendor).

## Why three timer engines, one decision

Each shell has a fundamentally different process model, so the _timer
engine_ stays per-shell:

- **CLI** is a long-running node process — a `setTimeout` chain is enough.
- **Electron** has a renderer that's alive whenever the window is
  open, so the React tree owns the timer — moving it to the main
  process would force IPC chatter for every cycle tick.
- **Android** has neither a long-running node process nor a
  guaranteed-alive WebView. The OS will tear down the WebView when
  the user swipes the app from recents; only a foreground service +
  AlarmManager survives that and Doze deep-sleep.

What they DO share is the cadence _decision_ (`computeNextCycleDelayMs`)
and what a "cycle" means (`services/manualVote.js` for the manual to-100%
path, `api/main.js#fetchChallengesAndVote` for the auto-strategy path).
Sharing the decision is what keeps last-minute entry timing correct on all
three; sharing the timer engine would force the lowest common denominator
(the Android constraints), which would be wrong for CLI and Electron.
