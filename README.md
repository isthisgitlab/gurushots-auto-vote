# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml/badge.svg?branch=master&event=push)](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/isthisgitlab/gurushots-auto-vote/badge.svg?branch=master)](https://coveralls.io/github/isthisgitlab/gurushots-auto-vote?branch=master)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

Automated voting for GuruShots challenges. The same voting engine ships three ways: a desktop **GUI** (Electron), a **CLI** (`gurucli`), and an **Android** app (sideloaded APK) that keeps voting in the background.

**🇱🇻 [Dokumentācija latviešu valodā →](README.lv.md)**

## Table of Contents

- [⚠️ Single-Instance Warning](#️-single-instance-warning)
- [🚀 Features](#-features)
- [📥 Download & Install](#-download--install)
- [🎯 Quick Start](#-quick-start)
- [🔧 Usage guide](docs/usage.md)
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
- **Scenarios** — your own multi-day plans for a challenge: phases with their own settings, and rules that enter photos, swap, boost, play turbo, wait or notify you at the times and conditions you choose. Built in a visual editor (or as JSON), shared as files, and previewed with a what-if simulation before they spend anything.
- **Desktop notifications** — optional warnings a few minutes before a boost, turbo or auto-submit, plus the messages your scenarios send.
- **Three platforms** — Electron GUI, `gurucli` command line, and an Android app that votes with the phone locked.
- **Resilient API layer** — configurable timeout plus automatic retry/backoff on transient failures.
- **Quality-of-life** — light/dark themes, English/Latvian UI, timezone display, mock mode for safe testing, and built-in update notifications.

## 📥 Download & Install

### Latest builds

**Latest Version: v1.11.0**

#### 🖥️ GUI (recommended for most users)

| Platform          | Download                                                                                                                                                               | Size    | Type                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.11.0-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x64.exe)                 | ~270 MB | Portable Executable |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.11.0-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.dmg)             | ~310 MB | DMG Installer       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.11.0-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.app.zip)     | ~335 MB | App Bundle (ZIP)    |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.11.0-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x86_64.AppImage) | ~270 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.11.0-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.AppImage)   | ~255 MB | AppImage            |

> **macOS:** Apple Silicon (arm64) only — there is no Intel (x86_64) build. The **DMG** is the simplest install; the **APP** zip is an alternative if you'd rather drop the bundle in yourself.

> **Why the downloads are large:** every build (GUI, Android, and CLI) ships a ~200 MB image-recognition model (Google SigLIP, 8-bit quantized) plus its runtime. Auto-submit uses it to check that a photo actually shows the challenge's subject — see [Visual check](docs/usage.md#auto-submit-missing-entries). It runs entirely on your device: nothing is downloaded on first use, no API key or account is needed, and no photo is uploaded anywhere. Don't want it? Take a [lite build](#-lite-builds-no-image-model) instead.

#### 📱 Mobile (Android sideload — no Play Store)

| Platform                     | Download                                                                                                                                       | Size    | Type       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v1.11.0.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0.apk) | ~160 MB | Signed APK |

The Android build is a Capacitor wrapper around the same React UI, plus a Kotlin plugin that runs voting cycles natively in the background via `AlarmManager` and a foreground service. Voting continues with the phone locked and the app swiped away from recents.

#### 💻 CLI (for power users / automation)

| Platform              | Download                                                                                                                               | Size    | Type                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| **macOS CLI**         | [📥 gurucli-v1.11.0-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-mac)             | ~375 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-v1.11.0-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux)         | ~355 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.11.0-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-arm) | ~350 MB | Terminal Executable |

> There is no Windows CLI build — on Windows, use the GUI app above.

#### 🪶 Lite builds (no image model)

Every download above also comes as a **lite** build without the image model and its runtime: the macOS DMG shrinks from ~310 MB to ~130 MB and the macOS CLI from ~375 MB to ~140 MB. Everything else works the same — auto-submit just skips the [visual check](docs/usage.md#auto-submit-missing-entries) and keeps its tag-based ranking. A lite GUI or Android install is only offered lite updates (the lite desktop app skips pre-releases).

| Platform                     | Download                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**                  | [📥 GuruShotsAutoVote-v1.11.0-x64-lite.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x64-lite.exe)                 |
| **macOS (DMG)**              | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.dmg)             |
| **macOS (APP)**              | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.app.zip)     |
| **Linux (x64)**              | [📥 GuruShotsAutoVote-v1.11.0-x86_64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x86_64-lite.AppImage) |
| **Linux (ARM64)**            | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.AppImage)   |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v1.11.0-lite.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-lite.apk)                         |
| **macOS CLI**                | [📥 gurucli-v1.11.0-mac-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-mac-lite)                                             |
| **Linux CLI (x64)**          | [📥 gurucli-v1.11.0-linux-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-lite)                                         |
| **Linux CLI (ARM64)**        | [📥 gurucli-v1.11.0-linux-arm-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-arm-lite)                                 |

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

1. Download `gurucli-v1.11.0-mac`.
2. `cd ~/Downloads`
3. Make it executable: `chmod +x gurucli-v1.11.0-mac`
4. Clear the quarantine flag (browser downloads only): `xattr -d com.apple.quarantine ./gurucli-v1.11.0-mac`
5. Run: `./gurucli-v1.11.0-mac help`

The first time the CLI submits a photo, it unpacks its bundled image model and runtime (~560 MB) into `~/Library/Application Support/gurushots-auto-vote/vision/`. This happens once per version; after unpacking, a new version removes older copies that haven't been used in the last hour.

#### 🐧 Linux

**GUI (AppImage):**

1. Download the AppImage for your architecture.
2. Make it executable: `chmod +x GuruShotsAutoVote-v1.11.0-*.AppImage` (or via file-manager → Properties → Permissions).
3. Run it: `./GuruShotsAutoVote-v1.11.0-*.AppImage`

**CLI:**

1. Download `gurucli-v1.11.0-linux` (or `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.11.0-linux`
4. `./gurucli-v1.11.0-linux help`

The first time the CLI submits a photo, it unpacks its bundled image model and runtime (~550 MB) into `~/.config/gurushots-auto-vote/vision/`. This happens once per version; after unpacking, a new version removes older copies that haven't been used in the last hour.

#### 📱 Android (sideload)

The Android build is **not on Google Play** — install via direct APK download.

1. On the phone, open the [latest release page](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) and tap `GuruShotsAutoVote-v1.11.0.apk`.
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
./gurucli-v1.11.0-[platform] login    # authenticate once (saves a token)
./gurucli-v1.11.0-[platform] run      # one full auto-strategy cycle (boost/turbo/auto-submit/threshold-aware vote)
./gurucli-v1.11.0-[platform] start    # continuous voting (Ctrl+C to stop)
```

> Replace `[platform]` with `mac`, `linux`, or `linux-arm`. Run `help` to see every command.

For GUI and CLI instructions, voting rules, settings, logs, and troubleshooting, see the [usage guide](docs/usage.md).

## 🔒 Security

- All API calls use HTTPS.
- Credentials are redacted from logs — sensitive keys are masked before any log write.
- Your token is stored locally in the app's settings file and is sent only to GuruShots; settings and config never leave your device.
- Error messages don't expose sensitive information.
- The auto-submit image check runs locally with a bundled model; it only downloads your own photo thumbnails from GuruShots and sends nothing to any other service.

## 📄 License & Support

Licensed under the **ISC License**.

For help, check [Troubleshooting](docs/usage.md#-troubleshooting) first, then [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

If this tool is useful to you, you can support development:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

---

**Note:** This application is for educational and development purposes. Please respect GuruShots' terms of service and use it responsibly.
