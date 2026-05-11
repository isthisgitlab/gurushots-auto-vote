# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/workflows/Build%20and%20Release/badge.svg)](https://github.com/isthisgitlab/gurushots-auto-vote/actions)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

An Electron application for automated voting on GuruShots challenges. Features both a graphical interface and
command-line tools for easy automation.

## ⚠️ IMPORTANT: Single Instance Warning

**🚨 CRITICAL**: This application is designed to run **ONLY ONE INSTANCE** per computer. Running multiple instances (GUI or CLI) simultaneously will likely cause:

- **API Rate Limit Exceeded**: GuruShots will block your requests
- **Failed Voting**: The application will stop working properly
- **Account Issues**: Potential temporary restrictions on your GuruShots account
- **Unpredictable Behavior**: Conflicts between instances

**✅ Recommended Usage:**

- Use **either** the GUI **or** CLI version, but not both at the same time
- Close any existing instances before starting a new one
- If you need to switch between GUI and CLI, stop the current instance first

**🔧 If you encounter rate limit errors:**

1. Stop all instances of the application
2. Wait 5-10 minutes before trying again
3. Ensure only one instance is running

## ☕ Support the Project

If you find this tool helpful, consider supporting its development:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`  
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

## 🚀 Features

- **Automated Voting**: Automatically vote on images in active challenges
- **Boost Management**: Apply boosts when available and near deadline
- **Turbo Auto-Earn**: Automatically play the in-app mini-game to earn turbo when none is held
- **Turbo Auto-Apply**: Automatically apply earned turbo to a configured entry slot before challenge end
- **Per-Entry Boost & Turbo**: Manually apply boost or turbo to a specific photo from the GUI
- **Auto-Fill Missing Entries**: Submit additional photos when a challenge nears its deadline and you have empty slots; staggered one-per-cycle so vote dilution doesn't penalize the new entries
- **Manual Fill Buttons**: `+1` and `+N` buttons on each challenge card to fill empty entry slots on demand, bypassing the auto spacing
- **Last Minute Threshold**: Auto-vote when challenges are within the last-minute threshold, ignoring exposure limits
- **Last Hour Exposure Cap**: Separate, tighter exposure ceiling that kicks in during the final hour
- **Only-Boost Mode**: Disable normal voting on a challenge until a boost (or turbo) is available
- **Dual Interface**: Use the GUI for manual control or CLI for automation
- **Secure Login**: Safe authentication with GuruShots
- **Remember Me**: Stay logged in across sessions
- **Theme Support**: Light and dark mode options
- **Internationalization**: Multi-language support with dynamic language selection
- **Configurable Timeouts**: Customizable API timeout and voting interval settings
- **Enhanced Security**: Improved token handling and reduced sensitive data exposure
- **Auto-Updater**: Built-in update notifications and download flow
- **Mock Mode**: Test the app without real API calls

## 📥 Download & Install

### **🚀 Quick Download Links**

**Latest Version: v0.10.4**

#### **🖥️ GUI Applications (Recommended for most users)**

| Platform          | Download                                                                                                                                                               | Size   | Type                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v0.10.4-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4-x64.exe)                 | ~50 MB | Portable Executable |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v0.10.4-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4-arm64.dmg)             | ~50 MB | DMG Installer       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v0.10.4-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4-arm64.app.zip)     | ~50 MB | App Bundle (ZIP)    |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v0.10.4-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4-x86_64.AppImage) | ~50 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v0.10.4-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4-arm64.AppImage)   | ~50 MB | AppImage            |

#### **📱 Mobile (Android sideload — no Play Store)**

| Platform                     | Download                                                                                                                                       | Size   | Type       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| **Android (8.0+, sideload)** | [📥 GuruShotsAutoVote-v0.10.4.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.10.4.apk) | ~10 MB | Signed APK |

The Android build is a Capacitor wrapper around the same React UI plus a custom Kotlin plugin that runs voting cycles natively in the background via `AlarmManager` + a foreground service. Voting continues with the phone locked and the app swiped from recents.

#### **💻 CLI Applications (For advanced users)**

| Platform              | Download                                                                                                                               | Size   | Type                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- |
| **macOS CLI**         | [📥 gurucli-v0.10.4-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.10.4-mac)             | ~55 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-v0.10.4-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.10.4-linux)         | ~50 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-v0.10.4-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.10.4-linux-arm) | ~47 MB | Terminal Executable |

### **📋 Installation Instructions**

#### **🪟 Windows Users**

1. **Download**: Click the Windows link above to download the `.exe` file
2. **Run**: Double-click the downloaded file to start the app
3. **No Installation Required**: The app runs directly from the executable
4. **First Run**: The app will create configuration files in your user directory

**✅ That's it!** The app is ready to use.

#### **🍎 macOS Users**

**Option 1: DMG Installer (Recommended)**

1. **Download**: Click the macOS (DMG) link above to download the `.dmg` file
2. **Open DMG**: Double-click the downloaded `.dmg` file
3. **Install**: Drag the app icon to the Applications folder
4. **Launch**: Open the app from your Applications folder

**Option 2: App Bundle (Direct)**

1. **Download**: Click the macOS (APP) link above to download the `.app.zip` file
2. **Extract**: Double-click the zip file to extract the `.app` bundle
3. **Move**: Move the extracted app to your Applications folder
4. **Launch**: Open the app from your Applications folder

**🔧 If you get security warnings:**

```bash
# Open Terminal and run this command (replace with your actual path):
xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
```

**💻 For CLI users on macOS:**

1. Download the `gurucli-v0.10.4-mac` file
2. Open Terminal
3. Navigate to the download folder: `cd ~/Downloads`
4. Make executable: `chmod +x gurucli-v0.10.4-mac`
5. Run: `./gurucli-v0.10.4-mac`

#### **🐧 Linux Users**

**GUI App (AppImage):**

1. **Download**: Click the appropriate Linux link above
2. **Make Executable**: Right-click the file → Properties → Permissions → Check "Allow executing file as program"
    - Or use terminal: `chmod +x GuruShotsAutoVote-v0.10.4-*.AppImage`
3. **Run**: Double-click the file or run from terminal: `./GuruShotsAutoVote-v0.10.4-*.AppImage`

**CLI App:**

1. Download the appropriate `gurucli-v0.10.4-linux` file
2. Open terminal and navigate to download folder: `cd ~/Downloads`
3. Make executable: `chmod +x gurucli-v0.10.4-linux`
4. Run: `./gurucli-v0.10.4-linux`

#### **📱 Android Users (Sideload)**

The Android build is **not on Google Play** — install via direct APK download.

1. **On the phone**, open the [latest release page](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) and tap `GuruShotsAutoVote-v0.10.4.apk`
2. Chrome will warn before downloading an APK — tap **Download anyway**
3. Tap the downloaded file from the notification shade
4. Android will prompt **Install unknown apps** — grant the permission for whichever app you used to download (Chrome / Files / etc.) and tap **Install**
5. On first launch, the app will ask for two things you should grant:
    - **Notifications**: required for the persistent foreground notification that keeps voting alive while the app is closed
    - **Disable battery optimization** (Settings → Apps → GuruShots Auto Vote → Battery → Unrestricted): vendor-specific battery savers (Samsung, Xiaomi, OnePlus) will otherwise kill the service
6. Log in, tap **Start Auto Vote**. The persistent notification appears showing the last cycle time. You can swipe the app from recents — voting continues.

**Auto-update**: the app checks GitHub Releases on launch and prompts when a newer APK is available. Tap the prompt and Chrome handles the download → tap the downloaded APK → system installer takes over.

**Background voting limitations**:

- Vendor battery managers may kill the service. If voting stops, whitelist the app per-vendor (link in Settings).
- 1-min last-minute cadence requires `SCHEDULE_EXACT_ALARM` permission (auto-granted on Android 13+, manual on Android 12).

### **🎯 Which Version Should I Download?**

| User Type        | Recommended Download      | Why?                                                   |
| ---------------- | ------------------------- | ------------------------------------------------------ |
| **New Users**    | GUI App for your platform | Easiest to use, visual interface                       |
| **Mobile Users** | Android APK (sideload)    | Voting runs in the background while you use other apps |
| **Power Users**  | CLI App for your platform | More control, automation features                      |

### **🔗 Alternative: Browse All Releases**

If you need a specific version or want to see all available downloads:

- **📂 [View All Releases](https://github.com/isthisgitlab/gurushots-auto-vote/releases)**
- **📋 [Release Notes](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest)**

### **❓ Still Not Sure?**

**For most users**: Download the GUI app for your platform (Windows `.exe`, macOS `.dmg`, or Linux `.AppImage`)

**Need help?** Check the [Troubleshooting](#-troubleshooting) section below
or [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

### **🌍 Other Languages**

- **🇱🇻 [Latviešu valoda](docs/INSTALACIJA.md)** - Instalācijas ceļvedis latviešu valodā

## 🎯 Quick Start

### **GUI Mode (Recommended for beginners)**

Launch the application you downloaded and follow these steps:

1. **Login**: Enter your GuruShots credentials
2. **Choose Settings**: Select theme and whether to stay logged in
3. **View Challenges**: See your active challenges and voting status
4. **Start Voting**: Use the interface to manage your voting

### **CLI Mode (For advanced users)**

For CLI applications, use these commands after making the file executable:

Login with your credentials:

```
./gurucli-v0.10.4-[platform] login
```

Run a single voting cycle:

```
./gurucli-v0.10.4-[platform] vote
```

Start continuous voting:

```
./gurucli-v0.10.4-[platform] start
```

## 🔧 Usage

### **GUI Application**

The GUI provides a user-friendly interface for managing your GuruShots voting:

#### **Login Screen**:

- **Username/Email**: Enter your GuruShots account email
- **Password**: Enter your GuruShots account password
- **Remember Login**: Check to save your session after closing the app
- **Theme**: Choose between light and dark theme
- **Language**: Choose between English and Latvian

#### **Main Interface**:

- **Top Bar**:
    - **App Title**: Shows "GuruShots Auto Vote" on the left side
    - **Mock Status**: Indicates if the app is running in mock mode
    - **Settings Button**: Access application settings
    - **Logout**: Sign out of current session

- **Auto-Vote Controls** (above the challenge list):
    - **Start/Stop Auto-Vote**: Toggle button to start or stop the continuous voting loop
    - **Status Badge**: Current loop state (running, waiting, idle, etc.)
    - **Last Run**: Timestamp of the most recent voting cycle
    - **Cycles**: Number of voting cycles completed in the current session

- **Challenge List**:
    - **Title**: Challenge name
    - **End Time**: When the challenge will end
    - **Exposure**: Your current exposure percentage
    - **Status**: Voting status (Voted/Voting/Waiting)
    - **Per-Challenge Settings (⚙️)**: Gear button on each card opens a per-challenge override modal (boost time, exposure, last-minute threshold, only-boost, vote-only-in-last-minute, last-hour exposure, turbo settings)

- **Challenge Details**:
    - **Your Progress**: Current rank, exposure, and votes
    - **Your Photos**: Your submitted photos in this challenge
    - **Boost Status**: Whether boost is available and when it will be applied
    - **Turbo Status**: Whether a turbo is held and ready to apply

- **Per-Entry Actions** (on each photo badge):
    - **🚀 Apply Boost**: Manually apply the available boost to this specific photo
    - **⚡ Apply Turbo**: Manually apply the held turbo to this specific photo
    - Boost and turbo are mutually exclusive per entry — once a photo is boosted or turboed, neither button shows for that photo

- **Play Auto-Turbo** (on each open challenge card, when no turbo is held):
    - Triggers the in-app mini-game to earn turbo for that challenge
    - Hidden once a turbo is held; runs automatically during auto-vote when `autoTurbo` is enabled

- **Update Dialog**:
    - Appears when a new release is available
    - States: available → downloading (with progress) → ready to install, or error

### **CLI Commands**

> **⚠️ Remember**: Only run ONE instance (GUI or CLI) at a time to avoid API rate limits.

For the CLI application, use these commands:

Login with your credentials:

```
./gurucli-v0.10.4-[platform] login
```

Run one manual voting cycle (votes to 100% on every active challenge regardless of threshold or exposure settings — useful for a one-shot top-up):

```
./gurucli-v0.10.4-[platform] vote
```

Start continuous voting (respects all thresholds and per-challenge settings):

```
./gurucli-v0.10.4-[platform] start
```

Check current status:

```
./gurucli-v0.10.4-[platform] status
```

Show help:

```
./gurucli-v0.10.4-[platform] help
```

#### **Settings Management Commands**

The CLI also exposes the full settings system. Settings are shared with the GUI, so changes made here apply to both.

| Command                            | Purpose                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `list-settings`                    | Show all settings, their current values, and which were modified by the user       |
| `get-setting <key>`                | Print the current value of one setting                                             |
| `set-setting <key> <value>`        | Set any setting directly (no schema validation — power-user)                       |
| `set-global-default <key> <value>` | Set a global default with full schema validation                                   |
| `reset-setting <key>`              | Reset one setting to its default                                                   |
| `reset-all-settings`               | Reset every setting to defaults (preserves token, mock flag, and API headers)      |
| `reset-windows`                    | Reset GUI window positions to defaults                                             |
| `help-settings`                    | Print detailed help for the settings system, including key names and value formats |

**Examples:**

```
./gurucli-v0.10.4-[platform] set-global-default exposure 80
./gurucli-v0.10.4-[platform] set-global-default autoTurbo true
./gurucli-v0.10.4-[platform] list-settings
./gurucli-v0.10.4-[platform] reset-setting lastMinuteThreshold
```

### **Continuous Voting**

The continuous voting mode automatically runs voting cycles with dynamic interval scheduling:

- **Normal Operation**: Runs every 3 minutes (configurable via settings)
- **Within Last Minute Threshold**: Automatically switches to higher frequency (default: 1 minute)
- **Automatic Detection**: Monitors all active challenges and adjusts frequency based on their end times

## 📝 Logging

The application automatically logs activity to help with troubleshooting:

### **Log Locations**

- **macOS**: `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Windows**: `%APPDATA%/gurushots-auto-vote/logs/`
- **Linux**: `~/.config/gurushots-auto-vote/logs/`

## ⚙️ Settings

> **⚠️ Important**: Changing settings while auto-vote is running will stop the voting process. You will need to manually restart auto-vote after applying your new settings.
> **WINDOW MOVEMENT**: If you move the app window, it will automatically save its position but it will stop autovoting process as it is saving the position in settings.

The app automatically saves your preferences. Settings split into three groups: **app-wide preferences** (theme/language/window state), **global-only voting settings**, and **per-challenge voting settings** (which can be set globally as defaults and individually overridden per challenge).

#### **App Preferences**

| Setting                                   | Default           | Notes                                                                                                 |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `theme`                                   | `light`           | Light or dark mode                                                                                    |
| `language`                                | `en`              | `en` or `lv`                                                                                          |
| `stayLoggedIn`                            | `false`           | Persist session across restarts                                                                       |
| `apiTimeout`                              | `30` seconds      | API request timeout (1-120s recommended)                                                              |
| `checkFrequencyMin` / `checkFrequencyMax` | `3` / `3` minutes | Voting cycle delay range; cycle picks random delay in `[min, max]`. Set both equal for fixed cadence. |
| `windowBounds`                            | —                 | Remembers GUI window position and size                                                                |

#### **Global-Only Voting Settings**

| Setting                    | Default    | Range | Notes                                                                  |
| -------------------------- | ---------- | ----- | ---------------------------------------------------------------------- |
| `lastMinuteCheckFrequency` | `1` minute | 1-59  | Polling cadence when any challenge is within its last-minute threshold |

#### **Per-Challenge Voting Settings**

These can be set as global defaults and overridden per challenge:

| Setting                     | Default             | Range                | Purpose                                                             |
| --------------------------- | ------------------- | -------------------- | ------------------------------------------------------------------- |
| `exposure`                  | `100`               | 1-100%               | Target exposure ceiling for normal voting                           |
| `lastMinuteThreshold`       | `10`                | 1-59 min             | Window before challenge end to ignore exposure cap and vote to 100% |
| `voteOnlyInLastMinute`      | `false`             | bool                 | Restrict normal voting to the last-minute window only               |
| `onlyBoost`                 | `false`             | bool                 | Disable normal voting; only act when boost or turbo is available    |
| `useLastHourExposure`       | `false`             | bool                 | Enable a tighter exposure ceiling for the final hour                |
| `lastHourExposure`          | `100`               | 1-100%, ≤ `exposure` | The ceiling used during the final hour                              |
| `boostTime`                 | `3600` seconds (1h) | ≥ 0                  | How long before challenge end to apply boost                        |
| `autoTurbo`                 | `true`              | bool                 | Auto-play the mini-game to earn turbo when none is held             |
| `useTurbo`                  | `false`             | bool                 | Auto-apply held turbo before challenge end                          |
| `turboTime`                 | `7200` seconds (2h) | ≥ 0                  | How long before challenge end to apply turbo                        |
| `turboImageIndex`           | `1`                 | integer ≥ 1          | Which entry slot receives the auto-applied turbo                    |
| `turboApplyWhenBoostActive` | `false`             | bool                 | Allow turbo auto-apply during a boost-active window                 |
| `autoFill`                  | `false`             | bool                 | Auto-submit photos to fill empty entry slots near the deadline      |
| `autoFillIntervalMinutes`   | `10`                | 1-60 min             | Spacing between consecutive auto-fill submissions                   |

Settings are shared between GUI and CLI modes, so you can switch between them seamlessly. Use the CLI `list-settings` command to see every setting and which ones you've modified.

### **Settings Logic: Global Defaults vs. Per-Challenge Overrides**

The application uses a hierarchical settings system that gives you powerful control over how it behaves:

#### **How Settings Work**

- **Global Defaults**: These apply to all challenges unless overridden
- **Per-Challenge Overrides**: Custom settings for specific challenges that take precedence over global defaults
- **Effective Settings**: The app automatically determines which setting to use based on this hierarchy

#### **Example Scenarios**

- **Scenario 1**: Set global exposure to 80% but override a specific challenge to 100%
- **Scenario 2**: Configure most challenges to vote normally, but set a few to "boost only" mode
- **Scenario 3**: Use different last-minute thresholds for different types of challenges
- **Scenario 4**: Apply more aggressive check frequencies during critical time periods

#### **Benefits of This Approach**

- **Flexibility**: Configure each challenge exactly how you want it
- **Efficiency**: Set global defaults once and only override when needed
- **Strategic Control**: Optimize your voting strategy for each challenge type
- **Time-Saving**: No need to reconfigure settings for every new challenge

## ⏰ Last Minutes Threshold

The Last Minutes Threshold feature allows the app to automatically vote on challenges when they are within a specified time limit before ending, regardless of your current exposure percentage.

### **How It Works**

- **Default Threshold**: 10 minutes (configurable, range 1-59)
- **Behavior**: When a challenge is within the last minutes threshold:
    - The app ignores your normal exposure threshold
    - It will vote if your exposure is below 100%
    - This helps maximize your final ranking in time-sensitive situations

### **Configuration**

You can set the Last Minutes Threshold in the app settings:

- **Global Default**: Set a default threshold for all challenges
- **Per-Challenge Override**: Set different thresholds for specific challenges
- **Range**: 1-59 minutes (recommended: 10-30 minutes)

### **Example Scenarios**

- **Competitive Challenge**: Set a longer threshold (30-59 minutes) to ensure maximum exposure
- **Less Important Challenge**: Use a shorter threshold (5-10 minutes) to conserve votes
- **High-Value Challenge**: Set to 30+ minutes to maximize your chances of ranking well
- **Multiple Challenges Ending**: Different thresholds help prioritize which challenges get votes first
- **Strategic Voting**: Combine with exposure settings to control voting patterns throughout the challenge

### **Use Cases**

- **Final Push**: Ensure you reach 100% exposure before a challenge ends
- **Vote Conservation**: Only use votes when they matter most (near the end)
- **Ranking Optimization**: Maximize your final position by voting aggressively in final minutes
- **Time Management**: Automatically adjust voting behavior as deadlines approach

## 🎯 Vote Only in Last Minute Threshold

The Vote Only in Last Minute Threshold feature allows you to restrict auto-voting to only occur when a challenge is within the last-minute threshold. This is useful when you want to conserve votes and only vote strategically in the final moments of a challenge.

### **How It Works**

- **Default Setting**: Disabled (auto-vote normally)
- **When Enabled**: Auto-vote will only vote when within the last minutes threshold
- **Boost Mode Respect**: Still respects the boost-only mode setting

### **Configuration**

You can configure this setting in the app:

- **Global Default**: Set a default for all challenges
- **Per-Challenge Override**: Set different behavior for specific challenges
- **Combination**: Works with other settings like boost-only mode and last minutes threshold

### **Example Scenarios**

- **Vote Conservation**: Enable for all challenges to only vote in the final minutes
- **Mixed Strategy**: Enable for some challenges but not others based on importance
- **Boost + Last Minutes**: Configure to only apply boosts and only vote in last minutes
- **Seasonal Challenges**: Enable during busy periods when you're in many challenges
- **Ranking-Critical Challenges**: Disable for challenges where you want consistent voting throughout

### **Use Cases**

- **Limited Time**: When you can't check the app frequently and want to focus votes
- **Vote Economy**: When you want to maximize the impact of your limited votes
- **Strategic Timing**: When you believe late voting has more impact on rankings
- **Multiple Challenges**: When you're in many challenges and need to prioritize
- **Competition Strategy**: When you want to surprise competitors with a late surge

## ⚡ Last Minute Check Frequency

The Last Minute Check Frequency feature lets you tighten the polling cadence when at least one challenge has entered its last-minute threshold. This enables more responsive voting during critical time periods.

### **How It Works**

- **Default Setting**: 1 minute
- **Dynamic Behavior**: The app automatically adjusts its check frequency based on challenge states:
    - **Normal Operation**: Uses the standard voting interval (default: 3 minutes)
    - **Within Last-Minute Threshold**: Uses the last-minute check frequency (default: 1 minute)
    - **Automatic Detection**: Monitors all active challenges and switches to the tighter frequency if any are within their last-minute threshold

### **Configuration**

You can configure this setting in the app:

- **Global Setting**: Sets the frequency for all challenges (no per-challenge overrides)
- **Range**: 1-59 minutes (recommended: 1-5 minutes during the last-minute window)

### **Example Scenarios**

- **Normal Operation**: App checks every 3 minutes (standard voting interval)
- **Challenge within its last-minute threshold**: App switches to checking every 1 minute
- **Multiple challenges**: If any challenge is within its last-minute threshold, the higher frequency applies to all
- **Challenge ends**: App automatically returns to normal frequency

### **Use Cases**

- **Critical Timing**: More frequent checks during the final moments of challenges
- **Competitive Edge**: Maximize voting opportunities when time is limited
- **Resource Optimization**: Balance between responsiveness and API usage
- **Strategic Advantage**: Ensure votes are cast at optimal times

## ⚡ Turbo (Auto-Earn & Auto-Apply)

Turbo is GuruShots' long-game booster: you earn it by playing the in-app mini-game (a finite, slow-replenishing resource), then hold it until the moment you want to spend it on a specific photo. Unlike boost — which is tied to a per-challenge timer — turbo is a freely-applicable consumable. The app splits this lifecycle into two independent settings: **earn** and **apply**.

### **Auto-Earn (`autoTurbo`)**

- **What it does**: When enabled and no turbo is held, the app automatically plays the mini-game on each voting cycle to earn one turbo.
- **Default**: Enabled (`true`)
- **Per-challenge override**: Yes
- **Manual equivalent (GUI)**: The "Play Auto-Turbo" button on each challenge card

### **Auto-Apply (`useTurbo`)**

- **What it does**: When enabled and a turbo is held, the app applies it to entry slot `turboImageIndex` once the challenge has `turboTime` seconds or less remaining.
- **Default**: Disabled (`false`)
- **Per-challenge override**: Yes
- **Related settings**:
    - `turboTime` — how long before challenge end to apply (default: 7200 seconds = 2 hours)
    - `turboImageIndex` — which entry slot receives the turbo (default: 1, the first photo)
    - `turboApplyWhenBoostActive` — if `false` (default), turbo auto-apply is suppressed during a boost-active window; if `true`, both can run

### **Per-Entry Manual Apply**

In the GUI, each photo badge shows an `⚡` button when a turbo is held and that photo isn't already actioned. Clicking it applies the turbo to that specific entry, overriding the auto-apply slot. Boost and turbo are mutually exclusive on a single photo — once one is applied, neither button shows for that entry.

### **Coexistence with Boost**

- **Per-entry**: A single photo can be either boosted or turboed, never both.
- **Per-challenge timing**: By default, turbo auto-apply waits for the boost-active window to pass. Set `turboApplyWhenBoostActive` to `true` to allow both to apply within the same challenge (on different photos).

## 📥 Auto-Fill Missing Entries

When a challenge allows multiple submissions (`max_photo_submits` > 1) and you've only submitted a subset, the unfilled slots are wasted at close time. Auto-Fill detects this case near the deadline and submits photos from your eligible photo library to fill the open slots.

### **Auto Mode (`autoFill`)**

- **What it does**: When enabled, the scheduler submits **one photo per check cycle** to fill empty slots, spaced by `autoFillIntervalMinutes`.
- **Default**: Disabled (`false`)
- **Per-challenge override**: Yes

The trigger is `secondsRemaining ≤ slotsRemaining × autoFillIntervalMinutes × 60`. With the default 10-minute interval:

- 2 missing slots → fills land at T-20m and T-10m
- 3 missing slots → fills at T-30m, T-20m, T-10m
- 1 missing slot → fill at T-10m

The spacing matters because GuruShots' ranking algorithm dilutes votes per entry when multiple photos are submitted simultaneously. Time-spacing each submission gives every entry independent exposure.

### **Manual Buttons**

Each challenge card with empty slots shows two buttons in the **Your Entries** cell, alongside the existing turbo controls:

- **`+1`** — submits the best-ranked eligible photo immediately (one slot)
- **`+N`** — submits all `N` remaining slots at once, bypassing the spacing math (only shown when more than one slot is missing)

Manual click is explicit user intent, so it ignores both the `autoFill` toggle and the spacing rules. Both buttons are disabled while auto-vote is running, mirroring the existing turbo button behavior.

### **Photo Selection**

The picker ranks your eligible photos lexicographically by:

1. **Theme match score** — keywords from the challenge URL slug, title, and welcome message (HTML-stripped, light-stemmed) are matched against each photo's vision labels with a photography-noise stopword list (`shots`, `coins`, `level`, `allstar`, etc.) so welcome-message tokens stay meaningful
2. **Achievements count** — past wins are a strong quality signal when no theme match exists
3. **Vote total** — proven photos beat unproven ones
4. **Upload date** — last-resort tiebreak

The achievements + votes layers prevent the failure mode where a recently-uploaded but low-quality photo wins by default just because it's newest.

### **Configuration**

| Setting                   | Default | Range    | Purpose                                       |
| ------------------------- | ------- | -------- | --------------------------------------------- |
| `autoFill`                | `false` | bool     | Enable staggered auto-fill for this challenge |
| `autoFillIntervalMinutes` | `10`    | 1-60 min | Spacing between consecutive submissions       |

The interval is intentionally tunable because the right gap depends on your check-frequency setting and how aggressive you want to be near the deadline.

### **Boost & Turbo on New Entries**

Newly-submitted entries are picked up by the existing boost and turbo decision gates on the **next** check cycle, with no special-case wiring. As long as the last fill lands at least one cycle (≈3 minutes) before the boost key-unlocked window (T-15m), boost and turbo can apply to the new entries naturally. With the default 10-minute interval and a 3-minute cycle, this works for up to 3 missing slots.

### **Use Cases**

- **Forgot to upload everything**: You submitted 1 of 4 allowed photos and the challenge ends in 30 minutes — auto-fill submits the remaining 3, spaced
- **Multiple challenges, limited time**: Enable on all multi-photo challenges as a safety net so empty slots are never wasted
- **Manual top-up before bed**: Click `+N` on a card to immediately fill remaining slots before going offline
- **Test on a low-stakes challenge**: Defaults are off, so you opt in per-challenge when you trust the picker

## 🎚️ Last Hour Exposure

A tighter exposure ceiling that only applies during the final hour of a challenge — useful for backing off voting once you're confident in your final position.

### **How It Works**

- **Default**: Disabled (`useLastHourExposure: false`)
- **When enabled**: Within the last hour of a challenge, the app uses `lastHourExposure` (default: 100%) instead of the global `exposure` setting
- **Constraint**: `lastHourExposure` must be ≤ `exposure` (you can't raise the ceiling for the final hour, only lower it)
- **Per-challenge override**: Yes

### **Example**

- Global `exposure`: 100%, `lastHourExposure`: 80%, `useLastHourExposure`: enabled
- Result: the app votes up to 100% during the bulk of the challenge, but in the final hour it stops voting once you reach 80% — conserving votes when extra exposure has diminishing returns.

## 🛡️ Only-Boost Mode

The `onlyBoost` setting (per-challenge, default: `false`) disables normal voting on a challenge entirely — the app will only act on that challenge when a boost or turbo is available to apply. Useful for low-priority challenges where you want to spend boosts/turbos but not votes.

## 🌍 Internationalization

The application supports multiple languages with dynamic language selection:

- **Dynamic Language Switching**: Change languages on-the-fly without restarting
- **Supported Languages**: English (default) and Latvian

### **Language Selection**

You can change the application language through the settings interface. The language preference is automatically saved and restored on subsequent sessions.

## 🔍 Troubleshooting

### **Common Issues**

**"No authentication token found"**

- Try logging in again through the login screen

**"Network Error"**

- Check your internet connection
- Try again later

**"Token expired"**

- Log in again through the login screen

**Windows open off-screen**

- Restart the application
- If using CLI, run the reset-windows command

**"API Rate Limit Exceeded" or "Too Many Requests"**

- **Stop all instances** of the application (GUI and CLI)
- Wait 5-10 minutes before trying again
- Ensure only **one instance** is running at a time
- Check that no other applications are accessing GuruShots API

### **Get Help**

If you're having issues:

1. Check the logs in the locations mentioned above
2. Try restarting the application
3. Open an issue on GitHub with details about your problem

## 🔒 Security

- All API calls use secure HTTPS
- Credentials are never logged
- Tokens are stored locally and securely
- No sensitive information is exposed in error messages

## 📄 License

This project is licensed under the ISC License.

## 🆘 Support

For issues and questions:

1. Check the troubleshooting section above
2. Open an issue on GitHub

---

**Note**: This application is for educational and development purposes. Please respect GuruShots' terms of service and
use responsibly.
