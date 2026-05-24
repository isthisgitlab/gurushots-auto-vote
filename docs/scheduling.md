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
lastMinuteCheckMinutes, minGapMs })` returns `{ delayMs, mode, nextEntry }`:

- **last-minute**: a challenge is already inside its `lastMinuteThreshold`
  window → fixed `lastMinuteCheckMinutes` cadence.
- **approaching**: the soonest upcoming threshold boundary is closer than
  the rolled random delay → wait is capped to that boundary so the next
  cycle lands on it instead of overshooting.
- **normal**: otherwise the random delay in `[checkFrequencyMin,
checkFrequencyMax]`.

Every result is floored at `MIN_CYCLE_GAP_MS`. The host rolls the random
delay and resolves `lastMinuteCheckFrequency`/per-challenge thresholds with
its own resolver (sync settings read on Node, async IPC in the WebView).
This is what fixed the bug where the next cycle could sleep past a
challenge's last-minute boundary and start the final voting push late.

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
