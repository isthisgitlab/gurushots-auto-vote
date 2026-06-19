# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml/badge.svg?branch=master&event=push)](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

Automated voting for GuruShots challenges. The same voting engine ships three ways: a desktop **GUI** (Electron), a **CLI** (`gurucli`), and an **Android** app (sideloaded APK) that keeps voting in the background.

**🇱🇻 [Instalācijas un lietošanas ceļvedis latviešu valodā →](docs/INSTALACIJA.md)**

## Table of Contents

- [⚠️ Single-Instance Warning](#️-single-instance-warning)
- [🚀 Features](#-features)
- [📥 Download & Install](#-download--install)
- [🎯 Quick Start](#-quick-start)
- [🔧 Usage](#-usage)
- [⚙️ How Voting Works](#️-how-voting-works)
- [🎛️ Settings Reference](#️-settings-reference)
- [📐 Recommended Setups](#-recommended-setups)
- [📝 Logging](#-logging)
- [🔍 Troubleshooting](#-troubleshooting)
- [🔒 Security](#-security)
- [📄 License & Support](#-license--support)

## ⚠️ Single-Instance Warning

**Run only ONE instance at a time** — one GUI **or** one CLI **or** one phone, never several at once. Multiple instances hammer the GuruShots API in parallel and can cause:

- **Rate-limit errors** — GuruShots blocks your requests
- **Failed voting** — cycles stop working correctly
- **Account restrictions** — temporary limits on your account

If you hit a rate-limit error: stop every instance, wait 5–10 minutes, then start a single one.

## 🚀 Features

- **Automated voting** — votes your active challenges up to a configurable exposure target.
- **Exposure control** — per-challenge exposure trigger and optional separate target ("vote up to X%").
- **Last-minute push** — votes to 100% inside a configurable window before a challenge closes, and tightens the polling cadence automatically.
- **Last-hour exposure** — a separate, usually lower exposure ceiling for the final hour.
- **Boost** — auto-applies boost near the deadline, on a chosen entry slot.
- **Turbo (earn + apply)** — auto-plays the mini-game to _earn_ turbo, then auto-_applies_ it to a chosen entry before the deadline.
- **Auto-fill** — submits photos into empty entry slots near the deadline, staggered to avoid vote dilution, with tag filters, theme-aware photo selection, and an emergency safety net.
- **Per-challenge overrides** — every voting setting has a global default that any individual challenge can override.
- **Per-title tag rules** — auto-fill tag rules keyed on the challenge title, so they survive GuruShots' per-rotation challenge-ID changes.
- **Three platforms** — Electron GUI, `gurucli` command line, and an Android app that votes with the phone locked.
- **Resilient API layer** — configurable timeout plus automatic retry/backoff on transient failures.
- **Quality-of-life** — light/dark themes, English/Latvian UI, timezone display, mock mode for safe testing, and built-in update notifications.

## 📥 Download & Install

### Latest builds

**Latest Version: v1.2.4**

#### 🖥️ GUI (recommended for most users)

| Platform          | Download                                                                                                                                                             | Size   | Type                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.2.4-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4-x64.exe)                 | ~50 MB | Portable Executable |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.2.4-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4-arm64.dmg)             | ~50 MB | DMG Installer       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.2.4-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4-arm64.app.zip)     | ~50 MB | App Bundle (ZIP)    |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.2.4-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4-x86_64.AppImage) | ~50 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.2.4-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4-arm64.AppImage)   | ~50 MB | AppImage            |

> **macOS:** Apple Silicon (arm64) only — there is no Intel (x86_64) build. The **DMG** is the simplest install; the **APP** zip is an alternative if you'd rather drop the bundle in yourself.

#### 📱 Mobile (Android sideload — no Play Store)

| Platform                     | Download                                                                                                                                     | Size   | Type       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v1.2.4.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.2.4.apk) | ~10 MB | Signed APK |

The Android build is a Capacitor wrapper around the same React UI, plus a Kotlin plugin that runs voting cycles natively in the background via `AlarmManager` and a foreground service. Voting continues with the phone locked and the app swiped away from recents.

#### 💻 CLI (for power users / automation)

| Platform              | Download                                                                                                                             | Size   | Type                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------- |
| **macOS CLI**         | [📥 gurucli-v1.2.4-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.2.4-mac)             | ~55 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-v1.2.4-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.2.4-linux)         | ~50 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.2.4-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.2.4-linux-arm) | ~47 MB | Terminal Executable |

> There is no Windows CLI build — on Windows, use the GUI app above.

Prefer a specific version? Browse **[all releases](https://github.com/isthisgitlab/gurushots-auto-vote/releases)** or the **[latest release notes](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest)**.

### Install per platform

#### 🪟 Windows

1. Download the `.exe` above.
2. Double-click to run — no installation needed; it runs straight from the executable.
3. On first run it creates its config and logs under `%APPDATA%\gurushots-auto-vote\`.
4. If SmartScreen warns, choose **More info → Run anyway**.

#### 🍎 macOS

1. **DMG:** open the `.dmg`, drag the app to **Applications**, launch from there.
   **APP:** unzip the `.app.zip`, move the app to **Applications**, launch from there.
2. If you get a security warning (Gatekeeper), clear the quarantine flag in Terminal — for the GUI app:

    ```bash
    xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
    ```

**CLI on macOS:**

1. Download `gurucli-v1.2.4-mac`.
2. `cd ~/Downloads`
3. Make it executable: `chmod +x gurucli-v1.2.4-mac`
4. Clear the quarantine flag (browser downloads only): `xattr -d com.apple.quarantine ./gurucli-v1.2.4-mac`
5. Run: `./gurucli-v1.2.4-mac help`

#### 🐧 Linux

**GUI (AppImage):**

1. Download the AppImage for your architecture.
2. Make it executable: `chmod +x GuruShotsAutoVote-v1.2.4-*.AppImage` (or via file-manager → Properties → Permissions).
3. Run it: `./GuruShotsAutoVote-v1.2.4-*.AppImage`

**CLI:**

1. Download `gurucli-v1.2.4-linux` (or `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.2.4-linux`
4. `./gurucli-v1.2.4-linux help`

#### 📱 Android (sideload)

The Android build is **not on Google Play** — install via direct APK download.

1. On the phone, open the [latest release page](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) and tap `GuruShotsAutoVote-v1.2.4.apk`.
2. Your browser warns before downloading an APK — tap **Download anyway**.
3. Tap the downloaded file from the notification shade.
4. Android prompts **Install unknown apps** — grant it to whichever app you downloaded with (Chrome / Files / etc.), then tap **Install**.
5. On first launch, grant both:
    - **Notifications** — for the persistent foreground notification that keeps voting alive while the app is closed.
    - **Disable battery optimization** (Settings → Apps → GuruShots Auto Vote → Battery → Unrestricted) — vendor battery savers (Samsung, Xiaomi, OnePlus…) otherwise kill the service.
6. Log in, tap **Start Auto Vote**. The persistent notification shows the last cycle time. You can swipe the app from recents — voting continues.

**Background limits:** vendor battery managers may still kill the service (whitelist the app per-vendor; link in Settings). The 1-minute last-minute cadence needs `SCHEDULE_EXACT_ALARM` (auto-granted on Android 13+, manual on Android 12).

## 🎯 Quick Start

### GUI

1. **Log in** with your GuruShots email and password.
2. Pick a **theme/language** and whether to **stay logged in**.
3. Open **Settings** and set your global defaults (start with `exposure` and the boost/turbo timings).
4. Optionally open a challenge's **⚙️** to override settings just for that challenge.
5. Click **Start Auto Vote**.

### CLI

```bash
./gurucli-v1.2.4-[platform] login    # authenticate once (saves a token)
./gurucli-v1.2.4-[platform] run      # one full auto-strategy cycle (boost/turbo/fill/threshold-aware vote)
./gurucli-v1.2.4-[platform] start    # continuous voting (Ctrl+C to stop)
```

> Replace `[platform]` with `mac`, `linux`, or `linux-arm`. Run `help` to see every command.

## 🔧 Usage

### GUI

- **Login screen** — email, password, _Remember login_, theme, and language.
- **Top bar** — app title, mock-mode indicator, Settings, and Logout.
- **Auto-Vote controls** — Start/Stop, a status badge (running / waiting / idle), the last-run timestamp, and the cycle count for the session.
- **Challenge list** — each card shows the title, end time, your exposure, and voting status. A **⚙️** button opens a per-challenge override modal (any voting setting can be overridden here; unset values fall back to your global defaults).
- **Jump-to-challenge bar** — a list of all active challenges above the cards; click a name to scroll straight to its card. A boost-window strip above it highlights challenges whose boost window is currently open.
- **Challenge details** — your rank/exposure/votes, your submitted photos, and boost/turbo status.
- **Per-entry actions** — on each photo, **🚀 Apply Boost** and **⚡ Apply Turbo** appear when available. Boost and turbo are mutually exclusive on a single photo, so once one is applied neither button shows for that entry.
- **Play Auto-Turbo** — on open challenges with no turbo held, triggers the mini-game to earn turbo (also runs automatically when `autoTurbo` is on).
- **Update dialog** — appears when a new release is available: available → downloading (with progress) → ready to install (or error).

> **Note:** changing settings or moving the GUI window while auto-vote is running **stops** the voting loop (window moves persist the new bounds to settings). Restart auto-vote after you're done.

### CLI commands

> **⚠️** Only run ONE instance (GUI or CLI) at a time.

| Command                                           | What it does                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `login`                                           | Authenticate with GuruShots and save a token (interactive; needs a real terminal).                                      |
| `logout`                                          | Clear the saved authentication token.                                                                                   |
| `vote`                                            | Run **one manual cycle** — votes to **100%** on every active challenge, ignoring all thresholds. A one-shot top-up.     |
| `run [--challenge=<id>]`                          | Run **one full auto-strategy cycle** (boost / turbo / auto-fill / threshold-aware vote). `--challenge` scopes to one.   |
| `boost --challenge=<id> [--image=<id>]`           | Apply a boost to one challenge. Without `--image` it uses the `boostImageIndex` slot.                                   |
| `turbo --challenge=<id>`                          | Play the turbo mini-game to earn turbo for one challenge (earn only; a held turbo is applied by `useTurbo` or the GUI). |
| `fill --challenge=<id> [--all]`                   | Submit the best-ranked photo into one empty slot, or `--all` to fill every empty slot at once.                          |
| `check-updates`                                   | Check GitHub for a newer release.                                                                                       |
| `start`                                           | Start **continuous** voting with dynamic scheduling. Runs until you press **Ctrl+C**.                                   |
| `status`                                          | Show mode (MOCK/REAL), auth status, and key settings.                                                                   |
| `get-setting <key> [--challenge=<id>]`            | Print a setting's effective value (per-challenge with `--challenge`).                                                   |
| `set-setting <key> <value> [--challenge=<id>]`    | Set a setting; with `--challenge` it writes a per-challenge override.                                                   |
| `set-global-default <key> <value>`                | Set a global default **with schema validation**.                                                                        |
| `list-settings [--challenge=<id>]`                | List all settings and which were modified (per-challenge view with `--challenge`).                                      |
| `reset-setting <key> [--challenge=<id>]`          | Reset a setting to default (or clear a challenge override with `--challenge`).                                          |
| `reset-all-settings`                              | Reset everything to defaults (preserves token, mock flag, and API headers).                                             |
| `logs [--error\|--api\|--settings] [--lines=<n>]` | Print the tail of a log file (default 100 lines; default category is the app log).                                      |
| `reset-windows`                                   | Reset GUI window positions to defaults.                                                                                 |
| `help-settings`                                   | Detailed help for the settings system — key names, value formats, ranges.                                               |
| `help`                                            | Show command help.                                                                                                      |

Settings are shared with the GUI: a `set-setting` from the CLI is picked up by the GUI and vice-versa.

> Replace `[platform]` below with `mac`, `linux`, or `linux-arm`.

```bash
./gurucli-v1.2.4-[platform] set-global-default exposure 80
./gurucli-v1.2.4-[platform] set-setting onlyBoost true --challenge=12345
./gurucli-v1.2.4-[platform] list-settings --challenge=12345
./gurucli-v1.2.4-[platform] logs --error --lines=50
```

## ⚙️ How Voting Works

### One voting cycle

A cycle is a single pass over all your active challenges. For each one the app, in order: applies **boost** if it's due, plays/applies **turbo** if eligible, **auto-fills** an empty entry slot if it's time, and then **votes** up to the target the rules below resolve.

### The exposure rules (which target applies)

Each challenge has an exposure **trigger** ("vote while my exposure is below this") and a vote **target** ("keep voting up to this %"). The first matching rule wins:

1. **Only-boost** (`onlyBoost`) — voting is skipped entirely; the app only applies boost/turbo.
2. **Not started yet** — skipped.
3. **Flash challenge** — always target **100%**.
4. **Vote-only-in-last-minute** (`voteOnlyInLastMinute`) — if set and the challenge is _not_ yet inside its last-minute window, voting is skipped.
5. **Last-minute window** — inside `lastMinuteThreshold` minutes of close, always target **100%** (exposure caps are ignored).
6. **Last hour** — if `useLastHourExposure` is on and under one hour remains, use the `lastHourExposure` trigger and `lastHourExposureTarget` target.
7. **Normal** — otherwise use the `exposure` trigger and `exposureTarget` target.

For triggers with a separate target, the app votes only when you're below the trigger, then keeps going up to the target. A target of `0` means "stop at the trigger" (target = trigger).

### Scheduling cadence

Continuous mode rolls a random delay in `[checkFrequencyMin, checkFrequencyMax]` minutes between cycles. As soon as any challenge enters its `lastMinuteThreshold` window, the scheduler switches to a fixed, tighter cadence (`lastMinuteCheckFrequency`, default every 1 minute) until no challenge is in that window, then reverts. (See [`docs/scheduling.md`](docs/scheduling.md) for the per-platform internals — CLI/Android share one engine; the GUI uses the same math.)

### Boost

When `autoBoost` is on, the app applies an available boost to the entry at `boostImageIndex` (1 = first photo, `0` = last; it steps back one slot if that entry is already turboed):

- **Timer-based boost** — applied once the boost has `boostTime` seconds or less left on its own timer.
- **Key-unlocked boost** (no timer) — the boost timer is ignored; it's applied only in the final 15 minutes before the challenge closes.

### Turbo (earn, then apply)

Turbo is a slow-replenishing consumable you earn by playing a mini-game, then spend whenever you like. The two halves are independent settings:

- **Auto-earn (`autoTurbo`, on by default)** — when no turbo is held, the app plays the mini-game each cycle to earn one. (GUI equivalent: the **Play Auto-Turbo** button.)
- **Auto-apply (`useTurbo`, off by default)** — when a turbo is held and the challenge has `turboTime` seconds or less remaining, it's applied to the entry at `turboImageIndex`. By default this waits until any open boost window has passed; set `turboApplyWhenBoostActive` to `true` to allow both within the same challenge (on different entries).

In the GUI you can also apply a held turbo to a specific photo with its **⚡** button, overriding the auto slot. A single photo can be either boosted or turboed, never both.

### Auto-fill missing entries

When a challenge allows multiple submissions and you've left slots empty, those slots are wasted at close time. With `autoFill` on, the scheduler submits **one photo per cycle** to fill them, spaced by `autoFillIntervalMinutes`, starting when `secondsRemaining ≤ slotsRemaining × autoFillIntervalMinutes × 60`. The spacing matters because GuruShots dilutes votes across entries submitted at the same moment, so staggering gives each new entry independent exposure.

- **`emergencyFill`** — a safety net: in the final stretch before close it fills any remaining slots even when the normal rules would wait, and overrides the must-include tag filter. Within this same window it also applies any available Boost and any won Turbo even when `autoBoost` / `useTurbo` are off for the challenge, so they aren't wasted at close. Entered as h+m in the GUI (stored as seconds). `0` disables it (which also disables the boost/turbo override); keep it `≤ lastMinuteThreshold` so the fast last-minute cadence is active throughout the window.
- **Tag filters** — `mustIncludeTags` is a hard filter (only photos matching all tags are eligible); `shouldIncludeTags` is a soft preference. `fillWithoutTagMatch` decides what happens when must-include tags are set but nothing matches every tag: fill anyway (default) or leave the slot empty.
- **Per-title tag rules** — because GuruShots recycles each challenge under a fresh ID every rotation, ID-keyed overrides are lost. Tag rules keyed on the (stable) challenge title are matched case-insensitively and merged into the effective must/should-include tag lists at fill time. Managed in the GUI Settings modal under **Per-Title Tag Rules** (GUI only).
- **Photo selection** — candidates are gathered with an always-on server-side themed search against GuruShots' own tag index — using your must/should-include tags when set, otherwise keywords from the challenge title — and fall back to your full eligible library if that surfaces nothing. Each candidate is then ranked by an always-on semantic theme score (how well it fits the challenge, `0`–`1`) — with keyword/stem matching against the photo's vision labels as the fallback when semantic data is unavailable — and ties broken by achievement count, total votes, views, then upload date.
- **Fill-new boost/turbo** — with `boostFillNew` / `turboFillNew` on, auto-fill submits a fresh photo and immediately boosts / turbos that new entry, so an available boost or turbo isn't left unused on an empty slot.
- **Manual buttons** — each card with empty slots shows **`+1`** (submit the best-ranked photo into one slot) and **`+N`** (fill all remaining slots at once, ignoring the spacing). Manual clicks ignore the `autoFill` toggle and are disabled while auto-vote is running.

Newly-filled entries are picked up by the boost and turbo gates on the _next_ cycle automatically.

### Only-boost mode

`onlyBoost` (per-challenge) turns off normal voting for that challenge — the app acts only when a boost or turbo can be applied. Useful for low-priority challenges where you want to spend boosts/turbos but not votes.

## 🎛️ Settings Reference

Settings come in two layers. **App preferences** are global to the app. **Challenge settings** have a global default and can be **overridden per challenge** (via the GUI ⚙️ modal or the CLI `--challenge` flag); the effective value is the per-challenge override if present, otherwise the global default.

### App preferences

| Setting                                   | Default       | Range / values  | Notes                                                                              |
| ----------------------------------------- | ------------- | --------------- | ---------------------------------------------------------------------------------- |
| `theme`                                   | `light`       | `light`, `dark` | UI theme.                                                                          |
| `language`                                | `en`          | `en`, `lv`      | UI language (English / Latvian); switches live.                                    |
| `timezone`                                | `Europe/Riga` | any IANA zone   | Timezone for displaying challenge times (`customTimezones` stores added zones).    |
| `stayLoggedIn`                            | `false`       | bool            | Skip the login window on next launch if a token exists.                            |
| `apiTimeout`                              | `30`          | 1–120 s         | Per-request API timeout.                                                           |
| `checkFrequencyMin` / `checkFrequencyMax` | `3` / `3`     | 1–60 min        | Random delay between cycles, picked in `[min, max]`. Equal values = fixed cadence. |
| `apiMaxRetries`                           | `3`           | 0–10            | Retries on transient failures (network/timeout/429/5xx). `0` disables.             |
| `apiRetryBaseDelayMs`                     | `1000`        | 100–10000 ms    | Base delay for exponential backoff between retries.                                |
| `windowBounds`                            | —             | —               | GUI window position/size (Electron); persisted automatically.                      |

### Challenge settings

All of these support per-challenge overrides except where noted.

**General**

| Setting          | Default | Range / values                         | Description                                                              |
| ---------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `exposure`       | `100`   | 1–100 %                                | Normal-rule trigger: vote while your exposure is below this.             |
| `exposureTarget` | `0`     | `0`, or 1–100 % (if set, ≥ `exposure`) | Vote up to this % when the normal rule fires. `0` = stop at the trigger. |
| `onlyBoost`      | `false` | bool                                   | Skip normal voting; only apply boost/turbo.                              |
| `compactCards`   | `false` | bool                                   | Compact challenge-card layout (GUI display only).                        |

**Boost**

| Setting           | Default       | Range / values | Description                                                                                 |
| ----------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `autoBoost`       | `true`        | bool           | Auto-apply boost near the deadline.                                                         |
| `boostTime`       | `3600` s (1h) | ≥ 0            | Apply a timer-based boost when this much time (or less) remains. Entered as h+m in the GUI. |
| `boostImageIndex` | `1`           | integer ≥ 0    | Entry slot to boost (1 = first, `0` = last). Steps back if that slot is already turboed.    |
| `boostFillNew`    | `false`       | bool           | During auto-fill, submit a fresh photo and immediately boost that new entry.                |

**Turbo**

| Setting                     | Default       | Range / values | Description                                                                              |
| --------------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `useTurbo`                  | `false`       | bool           | Auto-apply a held turbo before the deadline.                                             |
| `autoTurbo`                 | `true`        | bool           | Auto-play the mini-game to earn turbo when none is held.                                 |
| `turboTime`                 | `7200` s (2h) | ≥ 0            | Apply turbo when this much time (or less) remains. Entered as h+m in the GUI.            |
| `turboImageIndex`           | `1`           | integer ≥ 0    | Entry slot to turbo (1 = first, `0` = last). Steps back if that slot is already boosted. |
| `turboApplyWhenBoostActive` | `false`       | bool           | Allow turbo to apply while a boost window is open.                                       |
| `turboFillNew`              | `false`       | bool           | During auto-fill, submit a fresh photo and immediately turbo that new entry.             |

**Last hour**

| Setting                  | Default | Range / values                                 | Description                                                     |
| ------------------------ | ------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `useLastHourExposure`    | `false` | bool                                           | Use a separate exposure rule during the final hour.             |
| `lastHourExposure`       | `100`   | 1–100 % (≤ `exposure`)                         | Trigger used in the final hour.                                 |
| `lastHourExposureTarget` | `0`     | `0`, or 1–100 % (if set, ≥ `lastHourExposure`) | Vote up to this % in the final hour. `0` = stop at the trigger. |

**Last minute**

| Setting                    | Default | Range / values | Description                                                                                                    |
| -------------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `voteOnlyInLastMinute`     | `false` | bool           | Only vote while inside the last-minute window (window size = `lastMinuteThreshold`, not literally one minute). |
| `lastMinuteThreshold`      | `10`    | 1–59 min       | Window before close where the app votes to 100 % regardless of exposure caps.                                  |
| `lastMinuteCheckFrequency` | `1`     | 1–59 min       | **Global only (no per-challenge override).** Scheduler cadence while any challenge is in its window.           |

**Auto fill**

| Setting                   | Default      | Range / values | Description                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFill`                | `false`      | bool           | Submit photos into empty entry slots near the deadline (staggered, one per cycle).                                                                                                                                                                                                                 |
| `autoFillIntervalMinutes` | `10`         | 1–60 min       | Spacing between staggered auto-fill submissions.                                                                                                                                                                                                                                                   |
| `fillWithoutTagMatch`     | `true`       | bool           | If must-include tags are set but no photo matches all of them: fill anyway (`true`) or leave the slot empty (`false`).                                                                                                                                                                             |
| `emergencyFill`           | `300` s (5m) | ≥ 0            | Final-minutes safety net: fill remaining slots even if rules wait, overriding must-include tags; also applies any available Boost/won Turbo even when `autoBoost`/`useTurbo` are off. `0` = off (also disables the Boost/Turbo override). Keep ≤ `lastMinuteThreshold`. Entered as h+m in the GUI. |
| `mustIncludeTags`         | `[]`         | up to 50 tags  | Hard filter: only fill with photos matching all of these tags.                                                                                                                                                                                                                                     |
| `shouldIncludeTags`       | `[]`         | up to 50 tags  | Soft preference: prefer photos matching these tags, but don't exclude others.                                                                                                                                                                                                                      |

## 📐 Recommended Setups

**Maximum exposure everywhere** — push every active challenge to the top.
`exposure` 100, `lastMinuteThreshold` 30, check frequency 3 min, `onlyBoost` off, `voteOnlyInLastMinute` off. Start auto-vote and leave it running.

**Conserve votes, strike late** — only vote in the final minutes.
`exposure` 90, `lastMinuteThreshold` 15, `voteOnlyInLastMinute` on. The app waits until a challenge is inside its window, then votes to 100%.

**Boost-only** — spend boosts but no votes (e.g. low-priority challenges).
`onlyBoost` on, `boostTime` 7200 (2h), check frequency 10 min.

**Per-challenge tuning** — set sensible global defaults, then open a challenge's **⚙️** (GUI) or use `set-setting <key> <value> --challenge=<id>` (CLI) to override just the ones that matter for that challenge.

## 📝 Logging

Logs help with troubleshooting and are stored alongside your settings:

- **macOS:** `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Windows:** `%APPDATA%\gurushots-auto-vote\logs\`
- **Linux:** `~/.config/gurushots-auto-vote/logs/`

Files are rotated daily (`<type>-YYYY-MM-DD.log`) and auto-pruned by age and size, on startup and hourly while running:

| File         | Contents                                        | Kept    | Max size |
| ------------ | ----------------------------------------------- | ------- | -------- |
| `errors-*`   | Errors across all categories                    | 30 days | 10 MB    |
| `app-*`      | General application activity                    | 7 days  | 50 MB    |
| `settings-*` | Settings reads/writes                           | 7 days  | 10 MB    |
| `api-*`      | API requests/responses (source/dev builds only) | 1 day   | 20 MB    |

From the CLI, tail any of them with `logs [--error|--api|--settings] [--lines=<n>]`. Credentials are redacted before anything is written to disk.

## 🔍 Troubleshooting

**"No authentication token found" / "Token expired"** — log in again from the login screen (CLI: run `login`). Tokens are tied to your account; if it keeps happening, check your system clock.

**"Network Error"** — check your connection and firewall, raise `apiTimeout` (try 60–120 s), and try again later; GuruShots may be briefly unavailable.

**"API Rate Limit Exceeded" / "Too Many Requests"** — stop **all** instances (GUI and CLI), wait 5–10 minutes, and make sure only one is running.

**Auto-vote runs but nothing happens** — confirm you have active challenges, that your exposure isn't already at the trigger (default 100%), and that `voteOnlyInLastMinute` isn't on while challenges are still outside their last-minute window. Check the logs for the per-challenge skip reason.

**Window opens off-screen** — restart the app; from the CLI run `reset-windows`.

**Android: voting stops in the background** — set the app's battery usage to **Unrestricted** and whitelist it in your vendor's battery manager; on Android 12 grant the exact-alarm permission for the 1-minute last-minute cadence.

If you're still stuck, check the logs and [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues) with your version, OS, a description, reproduction steps, and relevant (credential-free) log excerpts.

## 🔒 Security

- All API calls use HTTPS.
- Credentials are redacted from logs — sensitive keys are masked before any log write.
- Your token is stored locally in the app's settings file and is sent only to GuruShots; settings and config never leave your device.
- Error messages don't expose sensitive information.

## 📄 License & Support

Licensed under the **ISC License**.

For help, check [Troubleshooting](#-troubleshooting) first, then [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

If this tool is useful to you, you can support development:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

---

**Note:** This application is for educational and development purposes. Please respect GuruShots' terms of service and use it responsibly.
