# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml/badge.svg?branch=master&event=push)](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/isthisgitlab/gurushots-auto-vote/badge.svg?branch=master)](https://coveralls.io/github/isthisgitlab/gurushots-auto-vote?branch=master)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

Automated voting for GuruShots challenges. The same voting engine ships three ways: a desktop **GUI** (Electron), a **CLI** (`gurucli`), and an **Android** app (sideloaded APK) that keeps voting in the background.

**🇱🇻 [Instalācijas un lietošanas ceļvedis latviešu valodā →](README.lv.md)**

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

The desktop app now enforces this for GUI instances: launching it a second time focuses the already-running window instead of starting a new copy. This does not cover running the CLI or the Android app alongside the GUI — the warning above still applies to those combinations.

## 🚀 Features

- **Automated voting** — votes your active challenges up to a configurable exposure target.
- **Exposure control** — per-challenge exposure trigger and optional separate target ("vote up to X%").
- **Last-minute push** — votes to 100% inside a configurable window before a challenge closes, and tightens the polling cadence automatically.
- **Final-window exposure** — a separate, usually lower exposure ceiling for a configurable window before close (default the final hour).
- **Boost** — auto-applies boost near the deadline, on a chosen entry slot.
- **Turbo (earn + apply)** — auto-plays the mini-game to _earn_ turbo, then auto-_applies_ it to a chosen entry before the deadline.
- **Auto-submit** — submits photos into empty entry slots near the deadline, staggered to avoid vote dilution, with tag filters, theme-aware photo selection double-checked by an on-device image model, and an emergency safety net.
- **Auto-join** — discovers open (un-joined) challenges and joins them automatically (off by default); once on it joins all of them by default, narrowed by an include/exclude challenge-type list or a challenge rule. Paid challenges are gated by per-challenge and per-cycle coin caps and never charged without a completed join. Manual joining is available too, via a collapsible "Discover" list in the GUI and the `discover`/`join` CLI commands.
- **Bankroll display** — shows your keys / swaps / fills / coins next to the timer in the GUI and via the `bankroll` (alias `coins`) CLI command.
- **Per-challenge overrides** — every voting setting has a global default that any individual challenge can override.
- **Challenge rules** — rules that match challenges by title, challenge tag, type, photo count or length (so they survive GuruShots' per-rotation challenge-ID changes), in an order you choose; each can assign a settings profile, switch auto-join / auto-submit, set join timing, and add auto-submit tags.
- **Three platforms** — Electron GUI, `gurucli` command line, and an Android app that votes with the phone locked.
- **Resilient API layer** — configurable timeout plus automatic retry/backoff on transient failures.
- **Quality-of-life** — light/dark themes, English/Latvian UI, timezone display, mock mode for safe testing, and built-in update notifications.

## 📥 Download & Install

### Latest builds

**Latest Version: v1.10.0**

#### 🖥️ GUI (recommended for most users)

| Platform          | Download                                                                                                                                                               | Size    | Type                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.10.0-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-x64.exe)                 | ~270 MB | Portable Executable |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.10.0-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64.dmg)             | ~310 MB | DMG Installer       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.10.0-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64.app.zip)     | ~335 MB | App Bundle (ZIP)    |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.10.0-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-x86_64.AppImage) | ~270 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.10.0-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64.AppImage)   | ~255 MB | AppImage            |

> **macOS:** Apple Silicon (arm64) only — there is no Intel (x86_64) build. The **DMG** is the simplest install; the **APP** zip is an alternative if you'd rather drop the bundle in yourself.

> **Why the downloads are large:** every build (GUI, Android, and CLI) ships a ~200 MB image-recognition model (Google SigLIP, 8-bit quantized) plus its runtime. Auto-submit uses it to check that a photo actually shows the challenge's subject — see [Visual check](#auto-submit-missing-entries). It runs entirely on your device: nothing is downloaded on first use, no API key or account is needed, and no photo is uploaded anywhere. Don't want it? Take a [lite build](#-lite-builds-no-image-model) instead.

#### 📱 Mobile (Android sideload — no Play Store)

| Platform                     | Download                                                                                                                                       | Size    | Type       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v1.10.0.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0.apk) | ~160 MB | Signed APK |

The Android build is a Capacitor wrapper around the same React UI, plus a Kotlin plugin that runs voting cycles natively in the background via `AlarmManager` and a foreground service. Voting continues with the phone locked and the app swiped away from recents.

#### 💻 CLI (for power users / automation)

| Platform              | Download                                                                                                                               | Size    | Type                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| **macOS CLI**         | [📥 gurucli-v1.10.0-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-mac)             | ~375 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-v1.10.0-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-linux)         | ~355 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.10.0-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-linux-arm) | ~350 MB | Terminal Executable |

> There is no Windows CLI build — on Windows, use the GUI app above.

#### 🪶 Lite builds (no image model)

Every download above also comes as a **lite** build without the image model and its runtime: the macOS DMG shrinks from ~310 MB to ~130 MB and the macOS CLI from ~375 MB to ~140 MB. Everything else works the same — auto-submit just skips the [visual check](#auto-submit-missing-entries) and keeps its tag-based ranking. A lite GUI or Android install is only offered lite updates (the lite desktop app skips pre-releases).

| Platform                     | Download                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**                  | [📥 GuruShotsAutoVote-v1.10.0-x64-lite.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-x64-lite.exe)                 |
| **macOS (DMG)**              | [📥 GuruShotsAutoVote-v1.10.0-arm64-lite.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64-lite.dmg)             |
| **macOS (APP)**              | [📥 GuruShotsAutoVote-v1.10.0-arm64-lite.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64-lite.app.zip)     |
| **Linux (x64)**              | [📥 GuruShotsAutoVote-v1.10.0-x86_64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-x86_64-lite.AppImage) |
| **Linux (ARM64)**            | [📥 GuruShotsAutoVote-v1.10.0-arm64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-arm64-lite.AppImage)   |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v1.10.0-lite.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.10.0-lite.apk)                         |
| **macOS CLI**                | [📥 gurucli-v1.10.0-mac-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-mac-lite)                                             |
| **Linux CLI (x64)**          | [📥 gurucli-v1.10.0-linux-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-linux-lite)                                         |
| **Linux CLI (ARM64)**        | [📥 gurucli-v1.10.0-linux-arm-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.10.0-linux-arm-lite)                                 |

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

1. Download `gurucli-v1.10.0-mac`.
2. `cd ~/Downloads`
3. Make it executable: `chmod +x gurucli-v1.10.0-mac`
4. Clear the quarantine flag (browser downloads only): `xattr -d com.apple.quarantine ./gurucli-v1.10.0-mac`
5. Run: `./gurucli-v1.10.0-mac help`

The first time the CLI submits a photo, it unpacks its bundled image model and runtime (~560 MB) into `~/Library/Application Support/gurushots-auto-vote/vision/`. This happens once per version; after unpacking, a new version removes older copies that haven't been used in the last hour.

#### 🐧 Linux

**GUI (AppImage):**

1. Download the AppImage for your architecture.
2. Make it executable: `chmod +x GuruShotsAutoVote-v1.10.0-*.AppImage` (or via file-manager → Properties → Permissions).
3. Run it: `./GuruShotsAutoVote-v1.10.0-*.AppImage`

**CLI:**

1. Download `gurucli-v1.10.0-linux` (or `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.10.0-linux`
4. `./gurucli-v1.10.0-linux help`

The first time the CLI submits a photo, it unpacks its bundled image model and runtime (~550 MB) into `~/.config/gurushots-auto-vote/vision/`. This happens once per version; after unpacking, a new version removes older copies that haven't been used in the last hour.

#### 📱 Android (sideload)

The Android build is **not on Google Play** — install via direct APK download.

1. On the phone, open the [latest release page](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) and tap `GuruShotsAutoVote-v1.10.0.apk`.
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
./gurucli-v1.10.0-[platform] login    # authenticate once (saves a token)
./gurucli-v1.10.0-[platform] run      # one full auto-strategy cycle (boost/turbo/auto-submit/threshold-aware vote)
./gurucli-v1.10.0-[platform] start    # continuous voting (Ctrl+C to stop)
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

| Command                                           | What it does                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                                           | Authenticate with GuruShots and save a token (interactive; needs a real terminal).                                                                   |
| `logout`                                          | Clear the saved authentication token.                                                                                                                |
| `vote`                                            | Run **one manual cycle** — votes to **100%** on every active challenge, ignoring all thresholds. A one-shot top-up.                                  |
| `run [--challenge=<id>]`                          | Run **one full auto-strategy cycle** (boost / turbo / auto-submit / threshold-aware vote). `--challenge` scopes to one.                              |
| `boost --challenge=<id> [--image=<id>]`           | Apply a boost to one challenge. Without `--image` it uses the `boostImageIndex` slot.                                                                |
| `turbo --challenge=<id>`                          | Play the turbo mini-game to earn turbo for one challenge (earn only; a held turbo is applied by `useTurbo` or the GUI).                              |
| `submit --challenge=<id> [--all]`                 | Submit the best-ranked photo into one empty slot, or `--all` to submit to every empty slot at once.                                                  |
| `bankroll` (alias `coins`)                        | Show your currency balances — keys / swaps / fills / coins.                                                                                          |
| `discover`                                        | List open (un-joined) challenges you can join, with each one's type and coin cost.                                                                   |
| `join <id> [--yes]`                               | Join an open challenge. Free challenges join immediately; a **paid** challenge prints its coin cost and requires `--yes` before any coins are spent. |
| `check-updates`                                   | Check GitHub for a newer release.                                                                                                                    |
| `start`                                           | Start **continuous** voting with dynamic scheduling. Runs until you press **Ctrl+C**.                                                                |
| `status`                                          | Show mode (MOCK/REAL), auth status, and key settings.                                                                                                |
| `get-setting <key> [--challenge=<id>]`            | Print a setting's effective value (per-challenge with `--challenge`).                                                                                |
| `set-setting <key> <value> [--challenge=<id>]`    | Set a setting; with `--challenge` it writes a per-challenge override.                                                                                |
| `set-global-default <key> <value>`                | Set a global default **with schema validation**.                                                                                                     |
| `list-settings [--challenge=<id>]`                | List all settings and which were modified (per-challenge view with `--challenge`).                                                                   |
| `reset-setting <key> [--challenge=<id>]`          | Reset a setting to default (or clear a challenge override with `--challenge`).                                                                       |
| `reset-all-settings`                              | Reset everything to defaults (preserves token, mock flag, and API headers).                                                                          |
| `logs [--error\|--api\|--settings] [--lines=<n>]` | Print the tail of a log file (default 100 lines; default category is the app log).                                                                   |
| `reset-windows`                                   | Reset GUI window positions to defaults.                                                                                                              |
| `help-settings`                                   | Detailed help for the settings system — key names, value formats, ranges.                                                                            |
| `help`                                            | Show command help.                                                                                                                                   |

Settings are shared with the GUI: a `set-setting` from the CLI is picked up by the GUI and vice-versa.

> Replace `[platform]` below with `mac`, `linux`, or `linux-arm`.

```bash
./gurucli-v1.10.0-[platform] set-global-default exposure 80
./gurucli-v1.10.0-[platform] set-setting onlyBoost true --challenge=12345
./gurucli-v1.10.0-[platform] list-settings --challenge=12345
./gurucli-v1.10.0-[platform] logs --error --lines=50
```

## ⚙️ How Voting Works

### One voting cycle

A cycle is a single pass over all your active challenges. For each one the app, in order: applies **boost** if it's due, plays/applies **turbo** if eligible, **auto-submits** a photo to an empty entry slot if it's time, and then **votes** up to the target the rules below resolve.

### The exposure rules (which target applies)

Each challenge has an exposure **trigger** ("vote while my exposure is below this") and a vote **target** ("keep voting up to this %"). The first matching rule wins:

1. **Only-boost** (`onlyBoost`) — voting is skipped entirely; the app only applies boost/turbo.
2. **Not started yet** — skipped.
3. **Flash challenge** — always target **100%**.
4. **Vote-only-in-last-minute** (`voteOnlyInLastMinute`) — if set and the challenge is _not_ yet inside its last-minute window, voting is skipped.
5. **Last-minute window** — inside `lastMinuteThreshold` minutes of close, always target **100%** (exposure caps are ignored).
6. **Final window** — if `useFinalWindowExposure` is on and the challenge is within `finalWindowDuration` of close (default 1 hour), use the `finalWindowExposure` trigger and `finalWindowExposureTarget` target.
7. **Normal** — otherwise use the `exposure` trigger and `exposureTarget` target.

For triggers with a separate target, the app votes only when you're below the trigger, then keeps going up to the target. A target of `0` means "stop at the trigger" (target = trigger).

**Vote on new entry** (`voteOnNewEntry`, off by default) changes only the "am I already at target?" test. When a new photo appears in a challenge — added by you on the website, or by auto-submit, emergency submit, or a fresh boost/turbo photo — the app votes once even if your exposure already reads at or above the trigger, up to whichever target the winning rule resolved (100% for flash, last-minute, and scheduled voting; `finalWindowExposureTarget` in the final window; `exposureTarget` otherwise). Adding a photo dilutes exposure immediately, but the reported figure doesn't always catch up on the same poll, so without this the fresh entry can sit unexposed for a cycle or more.

It never unblocks a rule that skips voting: if **only-boost** (step 1), **not-started** (step 2), **vote-only-in-last-minute** (step 4), or **scheduled-fill-only** (`scheduledFillReplaces`, outside its window) is blocking, no vote happens and the trigger is spent. These are the internal rule names the logs print, which is why that last one still reads "fill" while the setting is now labelled **Scheduled Voting** in the UI. If the vote itself fails, the trigger stays armed and the next cycle retries it.

### Scheduling cadence

Continuous mode rolls a random delay in `[checkFrequencyMin, checkFrequencyMax]` minutes between cycles. As soon as any challenge enters its `lastMinuteThreshold` window, the scheduler switches to a fixed, tighter cadence (`lastMinuteCheckFrequency`, default every 1 minute) until no challenge is in that window, then reverts. (See [`docs/scheduling.md`](docs/scheduling.md) for the per-platform internals — CLI/Android share one engine; the GUI uses the same math.)

### Boost

When `autoBoost` is on, the app applies an available boost to the entry at `boostImageIndex` (1 = first photo, `0` = last; it steps back one slot if that entry is already turboed):

- **Timer-based boost** — applied once the boost has `boostTime` seconds or less left on its own timer.
- **Key-unlocked boost** (no timer) — `boostTime` doesn't apply, because there is no timer to count down. It uses its own `keyUnlockedBoostTime` window (default 15 min) measured against the challenge's close time. Since a key-unlocked boost never expires, the default spends it as late as possible for maximum effect.

### Turbo (earn, then apply)

Turbo is a slow-replenishing consumable you earn by playing a mini-game, then spend whenever you like. The two halves are independent settings:

- **Auto-earn (`autoTurbo`, on by default)** — when no turbo is held, the app plays the mini-game each cycle to earn one. (GUI equivalent: the **Play Auto-Turbo** button.)
- **Auto-apply (`useTurbo`, off by default)** — when a turbo is held and the challenge has `turboTime` seconds or less remaining, it's applied to the entry at `turboImageIndex`. It does not wait for an open boost window — boost and turbo only never share an entry.

In the GUI you can also apply a held turbo to a specific photo with its **⚡** button, overriding the auto slot. A single photo can be either boosted or turboed, never both.

### Auto-submit missing entries

In GuruShots a **fill** is the currency that tops exposure up to 100% (one of the balances shown under [Bankroll](#bankroll)). Adding photos to empty entry slots is a different thing, and the app calls it **auto-submit**.

When a challenge allows multiple submissions and you've left slots empty, those slots are wasted at close time. With `autoFill` on, the scheduler submits **one photo per cycle** following your `autoFillSchedule` — a list of steps, each meaning "have at least `count` entries once `seconds` remain before close" (e.g. image 2 at 48h, image 3 at 3h, image 4 at 15min). If a challenge allows fewer images than the schedule covers, the whole schedule shifts toward the end so the last image's time applies to the challenge's final photo — in a 2-image challenge the 2nd photo uses the image-4 time, and in a 3-image challenge images 2/3 use the image-3/4 times. If you're behind schedule (the app started late, or a step exceeds the challenge's whole duration), it catches up one photo per cycle. The spacing matters because GuruShots dilutes votes across entries submitted at the same moment, so staggering gives each new entry independent exposure. Existing `autoFillIntervalMinutes` configs are migrated automatically (interval `M` becomes 2 @ 3×M, 3 @ 2×M, 4 @ 1×M minutes before close).

- **`emergencyFill`** (Emergency Submit) — a safety net: in the final stretch before close it submits photos to any remaining slots even when the normal rules would wait, and overrides the must-include tag filter. Within this same window it also applies any available Boost and any won Turbo even when `autoBoost` / `useTurbo` are off for the challenge, so they aren't wasted at close. Entered as h+m in the GUI (stored as seconds). `0` disables it (which also disables the boost/turbo override); keep it `≤ lastMinuteThreshold` so the fast last-minute cadence is active throughout the window.
- **Tag filters** — `mustIncludeTags` is a hard filter (only photos matching all tags are eligible); `shouldIncludeTags` is a soft preference. `fillWithoutTagMatch` decides what happens when must-include tags are set but nothing matches every tag: submit anyway (default) or leave the slot empty.
- **Rule tags** — a [challenge rule](#challenge-rules) can add must/should-include tags; they are merged into the effective tag lists at submit time, so a recurring challenge gets its tags back every rotation.
- **Photo selection** — candidates are gathered with an always-on server-side themed search against GuruShots' own tag index — using your must/should-include tags when set, otherwise keywords from the challenge title — and fall back to your full eligible library if that surfaces nothing. Each candidate is then ranked by an always-on semantic theme score (how well it fits the challenge, `0`–`1`) — with keyword/stem matching against the photo's vision labels as the fallback when semantic data is unavailable — and ties broken by achievement count, total votes, views, then upload date.
- **Visual check** — before a photo is submitted, an on-device image model looks at the top 12 ranked candidates and compares each one with the challenge — its title subject (series prefix, negated words like "No Humans", and your `ignoreTitleWords` removed) and the opening of its description (HTML and the standard rewards text stripped). Photos that clearly don't show the subject move behind the ones that do; among the photos that pass, the ranking above is kept, so popularity still decides. It works on every challenge with no configuration. It never leaves a slot empty: when the title has no visual subject ("Photo of the Day", "Guru of The Week"), when no photo clearly matches (abstract themes like "It's all About Balance"), or when the model can't run, the ranking above is used unchanged. The same check runs for auto-submit, emergency submit, the `+1`/`+N` buttons, fresh-photo boost/turbo, swaps, and auto-join. It takes about 1–1.5 s per challenge on a desktop CPU and longer on a phone; the model loads once, on the first photo submit after launch.
- **Fresh-photo boost/turbo** — with `boostFillNew` / `turboFillNew` on, the app submits a fresh photo and immediately boosts / turbos that new entry, so an available boost or turbo isn't left unused on an empty slot.
- **Manual buttons** — each card with empty slots shows **`+1`** (submit the best-ranked photo into one slot) and **`+N`** (submit to all remaining slots at once, ignoring the spacing). Manual clicks ignore the `autoFill` toggle and are disabled while auto-vote is running.

Newly submitted entries are picked up by the boost and turbo gates on the _next_ cycle automatically.

### Only-boost mode

`onlyBoost` (per-challenge) turns off normal voting for that challenge — the app acts only when a boost or turbo can be applied. Useful for low-priority challenges where you want to spend boosts/turbos but not votes.

### Auto-join challenges

Everything above operates on challenges you've already joined. **Auto-join** (off by default) discovers **open, un-joined** challenges each cycle and joins the ones you want. It runs as a pre-step before voting on every platform (GUI, CLI `start`, Android), and joining a challenge means submitting a photo — auto-join reuses the same photo picker as auto-submit (tags, themed search, semantic ranking, visual check).

- **Scope — which challenges get joined.** Turn on `autoJoin` and it joins **all** open challenges by default; narrow it with the type lists (optional):
    - `autoJoinTypes` — an **include** list of challenge types, comma-separated (e.g. `flash,contest`). Leave it **empty to join all types** (the default).
    - `autoJoinExcludeTypes` — a **deny** list of types to never join (e.g. `flash,exhibition`). Since the default is all, this alone gives "join everything except flash and exhibition".
    - A **rule opt-in** wins over both type lists: a [challenge rule](#challenge-rules) that switches auto-join on, or a profile assigned by a rule that names a title or challenge tag. A profile from a rule keyed only on type / photo count / length does **not** bypass the type lists — it says how to vote, not whether to join.
- **Paid challenges — coin safety.** Paid joins are **off by default** and gated by two caps, both `0 = off`: `autoJoinMaxCoins` (most coins to spend on a single join) and `autoJoinCycleCoinBudget` (total coins the pass may spend in one cycle). **Both must be > 0** to spend any coins. A paid join never charges without a completed join: the entry photo is resolved first (no photo ⇒ skip, no spend), and if the charge succeeds but the submit fails, the state is remembered so a retry finishes the submit instead of paying again.
- **Manual join.** A collapsed **Discover** panel below the challenge list shows open challenges; free ones join on click, paid ones open a confirmation showing the cost and your resulting balance. From the CLI use `discover` to list them and `join <id>` (paid needs `--yes`).
- **Indicator.** While autovote is running and auto-join is armed (the master is on, or a challenge rule enables it), an **"auto-join on"** badge shows in the header next to the timer — it appears only when the join step will actually run each cycle, not merely when the setting is on.
- **Join timing.** `autoJoinWithinHoursOfEnd` waits until a challenge is that many hours from its end; `autoJoinAfterPercentElapsed` waits until that share of its own length has run (75 = the last quarter), which suits both 24-hour and multi-week challenges. When the percent is above 0 it replaces the hours window. A challenge outside the window is reconsidered every cycle, not skipped for good.
- **Scoping / precedence.** `autoJoin`, the type/coin-cap settings and the join timing are resolved through the [challenge rules](#challenge-rules) (matched against the un-joined challenge itself), then the master default — so a rule can enable joining, loosen or tighten the caps, or change the timing for the challenges it matches, even with the master default off. Only `autoJoinCycleCoinBudget` stays global — a per-cycle total spend cap has no per-rule meaning.

### Challenge rules

GuruShots recycles each challenge under a fresh ID every rotation, so a per-challenge override is lost when the challenge comes back. **Challenge rules** match on what survives a rotation instead. They are managed under **Challenge Rules** in the Settings modal of the GUI and Android app; the CLI applies them but has no editor.

- **Conditions.** A rule can match on any mix of: one or more **titles** (is exactly / starts with / contains, case-insensitive — any listed title is enough), the challenge's own **tag** (Exhibition, Comm, …, not a photo tag), its **type** (default, flash, exhibition, …), its **photo count**, and its **length** — "runs at least" / "runs at most" in hours, measured start to end (24 h = 1 day, 168 h = 7 days). Every filled field must match; an empty field is ignored. A challenge whose start or end time is unknown never matches a length condition.
- **What a rule does.** Assign a settings **profile** (any per-challenge setting — voting, boost, turbo, …), switch **auto-join** / **auto-submit** on or off, set the **join timing** (percent of the challenge elapsed, or hours before end), and add must/should-include **photo tags**. An empty field means "inherit".
- **Order decides.** Rules are checked top to bottom. For each setting, the first matching rule that sets it wins — a rule's own value before its profile — and anything it leaves empty comes from the next matching rule, then the global default. Only **one profile** applies per challenge: the one from the first matching rule that names a profile. A per-challenge override set in the ⚙️ modal still beats every rule.
- **Default order.** **Sort by default order** puts rules naming a title first, then the rest; within each group the more specific rule goes higher. Roughly: exact titles before starts-with before contains, and more conditions before fewer — an extra condition can lift a starts-with rule level with an exact one, and then the longer title wins. Rules that tie are ordered photo count, then length, then type, then tag — e.g. `4 photos + ≥ 168 h` above `4 photos` above `≥ 168 h`. Reorder freely with the arrows; saving keeps your order.
- **Broad rules.** A rule without a title can switch auto-join or auto-submit on for every challenge it matches; the editor shows a warning when one does, since a single rule can then spend coins or photos across a whole group of challenges.
- **Upgrading.** When settings from an older version load, saved rules are put into the default order once and any "join timing by category" rules are moved into this list below them. Because a lower rule fills in what a higher one leaves empty, the settings log gets a warning for each pair of rules where that could switch auto-join or auto-submit on — review the order if you see one.

### Bankroll

Your currency balances — **keys / swaps / fills / coins** — show next to the timer in the GUI header (they read `—`, not `0`, if the balance can't be fetched, so a failed read is never mistaken for "empty"). From the CLI, `bankroll` (alias `coins`) prints them.

## 🎛️ Settings Reference

Settings come in two layers. **App preferences** are global to the app. **Challenge settings** have a global default and can be **overridden per challenge** (via the GUI ⚙️ modal or the CLI `--challenge` flag); the effective value is the per-challenge override if present, otherwise the global default.

### App preferences

| Setting                                   | Default       | Range / values  | Notes                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`                                   | `light`       | `light`, `dark` | UI theme.                                                                                                                                                                                                                                                                                                                                                                                 |
| `language`                                | `en`          | `en`, `lv`      | UI language (English / Latvian); switches live.                                                                                                                                                                                                                                                                                                                                           |
| `timezone`                                | `Europe/Riga` | any IANA zone   | Timezone for displaying challenge times (`customTimezones` stores added zones).                                                                                                                                                                                                                                                                                                           |
| `stayLoggedIn`                            | `false`       | bool            | Keep the saved token between runs. When off, the token is cleared when the app exits — GUI quit, or the CLI stopping on Ctrl+C **or `SIGTERM`** — so the next launch asks you to log in again. Note the `SIGTERM` case: a `gurucli start` run under systemd/Docker loses its login on every restart unless you turn this **on**. Not applied on Android, which has no reliable exit hook. |
| `apiTimeout`                              | `30`          | 1–120 s         | Per-request API timeout.                                                                                                                                                                                                                                                                                                                                                                  |
| `checkFrequencyMin` / `checkFrequencyMax` | `3` / `3`     | 1–60 min        | Random delay between cycles, picked in `[min, max]`. Equal values = fixed cadence.                                                                                                                                                                                                                                                                                                        |
| `apiMaxRetries`                           | `3`           | 0–10            | Retries on transient failures (network/timeout/429/5xx). `0` disables.                                                                                                                                                                                                                                                                                                                    |
| `apiRetryBaseDelayMs`                     | `1000`        | 100–10000 ms    | Base delay for exponential backoff between retries.                                                                                                                                                                                                                                                                                                                                       |
| `windowBounds`                            | —             | —               | GUI window position/size (Electron); persisted automatically.                                                                                                                                                                                                                                                                                                                             |

### Challenge settings

All of these support per-challenge overrides except where noted.

**General**

| Setting          | Default | Range / values                         | Description                                                                                                                                                                                                                    |
| ---------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exposure`       | `100`   | 1–100 %                                | Normal-rule trigger: vote while your exposure is below this.                                                                                                                                                                   |
| `exposureTarget` | `0`     | `0`, or 1–100 % (if set, ≥ `exposure`) | Vote up to this % when the normal rule fires. `0` = stop at the trigger.                                                                                                                                                       |
| `onlyBoost`      | `false` | bool                                   | Skip normal voting; only apply boost/turbo.                                                                                                                                                                                    |
| `voteOnNewEntry` | `false` | bool                                   | When a new photo appears, vote once even if exposure is already at/above the trigger, up to whichever target the winning rule resolves. Does not override Only Boost Mode, Vote Only in Last Minute, or Scheduled Voting Only. |

**Boost**

| Setting                | Default       | Range / values | Description                                                                                                                                                                                                      |
| ---------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoBoost`            | `true`        | bool           | Auto-apply boost near the deadline.                                                                                                                                                                              |
| `boostTime`            | `3600` s (1h) | ≥ 0            | Apply a timer-based boost when this much time (or less) remains **on the boost's own timer**. Entered as h+m in the GUI.                                                                                         |
| `keyUnlockedBoostTime` | `900` s (15m) | ≥ 0            | Separate window for a **key-unlocked** boost, which has no timer of its own — measured against the challenge close time. `boostTime` does not apply to these. `0` = never auto-apply. Entered as h+m in the GUI. |
| `boostImageIndex`      | `1`           | `0`–`4`        | Entry slot to boost (1 = first, `0` = last; a challenge holds at most 4 entries). Steps back if that slot is already turboed.                                                                                    |
| `boostFillNew`         | `false`       | bool           | Submit a fresh photo and immediately boost that new entry.                                                                                                                                                       |

**Turbo**

| Setting           | Default       | Range / values | Description                                                                                                                   |
| ----------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `useTurbo`        | `false`       | bool           | Auto-apply a held turbo before the deadline.                                                                                  |
| `autoTurbo`       | `true`        | bool           | Auto-play the mini-game to earn turbo when none is held.                                                                      |
| `turboTime`       | `7200` s (2h) | ≥ 0            | Apply turbo when this much time (or less) remains. Entered as h+m in the GUI.                                                 |
| `turboImageIndex` | `1`           | `0`–`4`        | Entry slot to turbo (1 = first, `0` = last; a challenge holds at most 4 entries). Steps back if that slot is already boosted. |
| `turboFillNew`    | `false`       | bool           | Submit a fresh photo and immediately turbo that new entry.                                                                    |

**Final window**

| Setting                        | Default | Range / values                                    | Description                                                                                                                                                                                                |
| ------------------------------ | ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useFinalWindowExposure`       | `false` | bool                                              | Use a separate exposure rule during the final window.                                                                                                                                                      |
| `finalWindowDuration`          | `3600`  | 60 s – 30 d (stored as seconds)                   | Length of the final window before close. Default 1 hour.                                                                                                                                                   |
| `finalWindowExposure`          | `100`   | 1–100 % (≤ `exposure`)                            | Trigger used in the final window.                                                                                                                                                                          |
| `finalWindowExposureTarget`    | `0`     | `0`, or 1–100 % (if set, ≥ `finalWindowExposure`) | Vote up to this % in the final window. `0` = stop at the trigger.                                                                                                                                          |
| `voteBeforeFinalWindow`        | `false` | bool                                              | Top up to the **standard** exposure target in a window straddling the final-window start, so decayed exposure isn't stranded by the lower final-window trigger. Only active with `useFinalWindowExposure`. |
| `voteBeforeFinalWindowLeadMin` | `15`    | 1–59 min                                          | Half-width (minutes) of the pre-final-window top-up window on each side of the final-window start.                                                                                                         |

**Last minute**

| Setting                    | Default | Range / values | Description                                                                                                    |
| -------------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `voteOnlyInLastMinute`     | `false` | bool           | Only vote while inside the last-minute window (window size = `lastMinuteThreshold`, not literally one minute). |
| `lastMinuteThreshold`      | `10`    | 1–59 min       | Window before close where the app votes to 100 % regardless of exposure caps.                                  |
| `lastMinuteCheckFrequency` | `1`     | 1–59 min       | **Global only (no per-challenge override).** Scheduler cadence while any challenge is in its window.           |

**Auto-submit**

| Setting               | Default             | Range / values | Description                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFill`            | `false`             | bool           | Submit photos into empty entry slots near the deadline (staggered, one per cycle).                                                                                                                                                                                                                                          |
| `autoFillSchedule`    | 2@30m, 3@20m, 4@10m | images 2–4     | `{count, seconds}` rows: have ≥ `count` entries once ≤ `seconds` remain. Images 2–4 only; omit an image (or set 0h 0m in the GUI) to never schedule it. Shifts toward the end when a challenge allows fewer images (its final photo uses the last row's time). Replaces `autoFillIntervalMinutes` (migrated automatically). |
| `fillWithoutTagMatch` | `true`              | bool           | If must-include tags are set but no photo matches all of them: submit anyway (`true`) or leave the slot empty (`false`).                                                                                                                                                                                                    |
| `emergencyFill`       | `300` s (5m)        | ≥ 0            | Emergency Submit — final-minutes safety net: submit to remaining slots even if rules wait, overriding must-include tags; also applies any available Boost/won Turbo even when `autoBoost`/`useTurbo` are off. `0` = off (also disables the Boost/Turbo override). Keep ≤ `lastMinuteThreshold`. Entered as h+m in the GUI.  |
| `mustIncludeTags`     | `[]`                | up to 50 tags  | Hard filter: only submit photos matching all of these tags.                                                                                                                                                                                                                                                                 |
| `shouldIncludeTags`   | `[]`                | up to 50 tags  | Soft preference: prefer photos matching these tags, but don't exclude others.                                                                                                                                                                                                                                               |

**Auto join**

| Setting                       | Default | Range / values    | Description                                                                                                                                                                                           |
| ----------------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoJoin`                    | `false` | bool              | Enable auto-join. When on, joins **all** open challenges by default. A [challenge rule](#challenge-rules) can turn it on (or off) for the challenges it matches, even when the master default is off. |
| `autoJoinTypes`               | `''`    | csv of types      | Scope: **include** only these challenge types, e.g. `flash,contest`. **Empty = all types** (the default). Case-insensitive; spaces around commas ignored.                                             |
| `autoJoinExcludeTypes`        | `''`    | csv of types      | **Never** join these types, e.g. `flash,exhibition`. Subtracts from the default-all scope, so this alone gives "join all except these". A rule opt-in still joins its challenges.                     |
| `autoJoinMaxCoins`            | `0`     | ≥ 0 (0 = off)     | Most coins to spend joining a **single** paid challenge. `0` = free challenges only.                                                                                                                  |
| `autoJoinCycleCoinBudget`     | `0`     | ≥ 0 (0 = off)     | Total coins the join pass may spend in **one cycle** (global). `0` = no paid spend. Paid joins require **both** this and `autoJoinMaxCoins` > 0.                                                      |
| `autoJoinWithinHoursOfEnd`    | `0`     | 0–720 h (0 = off) | Join a challenge only once it is within this many hours of its end. `0` = join as soon as it is seen.                                                                                                 |
| `autoJoinAfterPercentElapsed` | `0`     | 0–99 % (0 = off)  | Join a challenge only once this share of its own length has run. Above 0 it replaces the hours window.                                                                                                |

**Display**

| Setting              | Default | Range / values | Description                                                                                                                                     |
| -------------------- | ------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `compactCards`       | `false` | bool           | Compact challenge-card layout (GUI display only).                                                                                               |
| `compactCardActions` | `false` | bool           | Show the challenge-level action buttons (Vote, Run, Earn Turbo, submit, currency spends, Settings) on compact cards (GUI display only, global). |

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

The visual check logs under the `autoFill` category: `Visual check reordered picks for [Challenge …]` when it changed which photo gets submitted, and `Visual check unavailable for [Challenge …]` when the model couldn't run (the tag ranking was used instead). No line means it agreed with the ranking or abstained.

## 🔍 Troubleshooting

**"No authentication token found" / "Token expired"** — log in again from the login screen (CLI: run `login`). Tokens are tied to your account; if it keeps happening, check your system clock.

**"Network Error"** — check your connection and firewall, raise `apiTimeout` (try 60–120 s), and try again later; GuruShots may be briefly unavailable.

**"API Rate Limit Exceeded" / "Too Many Requests"** — stop **all** instances (GUI and CLI), wait 5–10 minutes, and make sure only one is running.

**Auto-vote runs but nothing happens** — confirm you have active challenges, that your exposure isn't already at the trigger (default 100%), and that `voteOnlyInLastMinute` isn't on while challenges are still outside their last-minute window. Check the logs for the per-challenge skip reason.

**Auto-submit picked an off-theme photo** — the visual check only chooses among the top 12 candidates the tag search found, so if none of them shows the subject it can't help: add `mustIncludeTags`/`shouldIncludeTags` for that challenge (or a [challenge rule](#challenge-rules)) so better candidates reach the shortlist. A `Visual check unavailable` log line means the image model failed to load or run; the CLI unpacks its model on first use (see [Install per platform](#install-per-platform)), so check free disk space.

**Window opens off-screen** — restart the app; from the CLI run `reset-windows`.

**Launching the app appears to do nothing (no window)** — a stale or frozen instance may still be running; a second launch defers to it and exits. Quit or kill the old process (Activity Monitor / `pkill -f GuruShotsAutoVote`) and launch again.

**Android: voting stops in the background** — set the app's battery usage to **Unrestricted** and whitelist it in your vendor's battery manager; on Android 12 grant the exact-alarm permission for the 1-minute last-minute cadence.

If you're still stuck, check the logs and [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues) with your version, OS, a description, reproduction steps, and relevant (credential-free) log excerpts.

## 🔒 Security

- All API calls use HTTPS.
- Credentials are redacted from logs — sensitive keys are masked before any log write.
- Your token is stored locally in the app's settings file and is sent only to GuruShots; settings and config never leave your device.
- Error messages don't expose sensitive information.
- The auto-submit image check runs locally with a bundled model; it only downloads your own photo thumbnails from GuruShots and sends nothing to any other service.

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
