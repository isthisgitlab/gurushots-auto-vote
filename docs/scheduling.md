# Voting cycle scheduling

This app runs the voting cycle on three different schedulers depending
on the shell. They look similar from the outside (one cycle ≈ every few
minutes) but the implementations are unrelated, intentionally so. Future
contributors should understand the split before reaching for "let's
unify these."

## CLI — node-cron via runScheduler

- **Owner**: `src/js/scheduling/runScheduler.js`
- **Started by**: `src/js/cli/cli.js` `start` command
- **Cadence**: dynamic. Picks `checkFrequencyMin..checkFrequencyMax`
  (random delay) under normal conditions; switches to a fixed
  `lastMinuteCheckFrequency` cadence when any active challenge enters
  its `lastMinuteThreshold` window.
- **Lifecycle**: lives as long as the node process. The CLI host owns
  signal handling and process keep-alive; the scheduler is just the
  cadence engine.

## Electron — UI-driven AutovoteContext

- **Owner**: `src/js/react/contexts/AutovoteContext.jsx`
- **Started by**: the Start / Stop button in the React UI (or auto-
  resume on mount when the persisted `autovoteRunning` flag is true).
- **Cadence**: same dynamic / last-minute split as the CLI, but
  implemented inline using `setInterval` / `setTimeout` against
  `runningRef`. Threshold transitions are computed via
  `calculateNextThresholdEntry` (`autovoteScheduler.js`) — the only
  pure piece pulled out for testability.
- **Lifecycle**: tied to the renderer window. Closing the window stops
  the loop. The persisted `autovoteRunning` flag means a relaunch
  resumes voting without the user re-clicking Start.

## Android — native Foreground Service + AlarmManager

- **Owner**: `src/js/services/NativeAutovoteBridge.js` (JS bridge to
  the custom Capacitor plugin `AutoVoteBackground`).
- **Fallback**: `src/js/services/ForegroundServiceController.js` runs
  the foreground notification only — used when the native plugin is
  not available on a given build.
- **Cadence**: owned by the native plugin (Java side). The plugin uses
  `AlarmManager.setExactAndAllowWhileIdle()` to fire cycles even when
  the WebView process is dead and the device is in Doze. The JS-side
  `AutovoteContext` cycle still runs while the app is open so the user
  gets immediate visual feedback (cycle counter, last-run timestamp).
- **Lifecycle**: independent of the WebView. Survives swipe-to-close.
  Only stopped explicitly via `nativeAutovote.stop()` or by
  vendor-specific battery killers (Samsung / Xiaomi / OnePlus may kill
  the foreground service; first-launch onboarding should prompt the
  user to whitelist the app per-vendor).

## Why three schedulers, not one

Each shell has a fundamentally different process model:

- **CLI** is a long-running node process — `setInterval` is enough.
- **Electron** has a renderer that's alive whenever the window is
  open, so the React tree owns scheduling — moving it to the main
  process would force IPC chatter for every cycle tick.
- **Android** has neither a long-running node process nor a
  guaranteed-alive WebView. The OS will tear down the WebView when
  the user swipes the app from recents; only a foreground service +
  AlarmManager survives that and Doze deep-sleep.

A shared scheduler module would have to be the lowest common
denominator (the Android constraints), which would be wrong for CLI
and Electron. Three implementations is the right shape; they just
need to agree on what a "cycle" means — and that part is shared via
`services/manualVote.js` (manual to-100% path) and
`api/main.js#fetchChallengesAndVote` (auto-strategy path).
