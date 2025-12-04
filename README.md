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
- **Last Minutes Threshold**: Auto-vote when challenges are within the last minutes threshold, ignoring exposure limits
- **Dual Interface**: Use the GUI for manual control or CLI for automation
- **Secure Login**: Safe authentication with GuruShots
- **Remember Me**: Stay logged in across sessions
- **Theme Support**: Light and dark mode options
- **Internationalization**: Multi-language support with dynamic language selection
- **Configurable Timeouts**: Customizable API timeout and voting interval settings
- **Enhanced Security**: Improved token handling and reduced sensitive data exposure
- **Mock Mode**: Test the app without real API calls

## 📥 Download & Install

### **🚀 Quick Download Links**

**Latest Version: v0.5.0**

#### **🖥️ GUI Applications (Recommended for most users)**

| Platform          | Download                                                                                                                                                             | Size   | Type                |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------|---------------------|
| **Windows**       | [📥 GuruShotsAutoVote-v0.5.0-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.5.0-x64.exe)                 | ~50 MB | Portable Executable |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v0.5.0-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.5.0-arm64.dmg)             | ~50 MB | DMG Installer       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v0.5.0-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.5.0-arm64.app.zip)             | ~50 MB | App Bundle (ZIP)    |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v0.5.0-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.5.0-x86_64.AppImage) | ~50 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v0.5.0-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.5.0-arm64.AppImage)   | ~50 MB | AppImage            |

#### **💻 CLI Applications (For advanced users)**

| Platform              | Download                                                                                                                           | Size   | Type                |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------|--------|---------------------|
| **macOS CLI**         | [📥 gurucli-v0.5.0-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.5.0-mac)             | ~55 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-v0.5.0-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.5.0-linux)         | ~50 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-v0.5.0-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v0.5.0-linux-arm) | ~47 MB | Terminal Executable |

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

1. Download the `gurucli-v0.5.0-mac` file
2. Open Terminal
3. Navigate to the download folder: `cd ~/Downloads`
4. Make executable: `chmod +x gurucli-v0.5.0-mac`
5. Run: `./gurucli-v0.5.0-mac`

#### **🐧 Linux Users**

**GUI App (AppImage):**

1. **Download**: Click the appropriate Linux link above
2. **Make Executable**: Right-click the file → Properties → Permissions → Check "Allow executing file as program"
    - Or use terminal: `chmod +x GuruShotsAutoVote-v0.5.0-*.AppImage`
3. **Run**: Double-click the file or run from terminal: `./GuruShotsAutoVote-v0.5.0-*.AppImage`

**CLI App:**

1. Download the appropriate `gurucli-v0.5.0-linux` file
2. Open terminal and navigate to download folder: `cd ~/Downloads`
3. Make executable: `chmod +x gurucli-v0.5.0-linux`
4. Run: `./gurucli-v0.5.0-linux`

### **🎯 Which Version Should I Download?**

| User Type       | Recommended Download      | Why?                                |
|-----------------|---------------------------|-------------------------------------|
| **New Users**   | GUI App for your platform | Easiest to use, visual interface    |
| **Power Users** | CLI App for your platform | More control, automation features   |

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
./gurucli-v0.5.0-[platform] login
```

Run a single voting cycle:
```
./gurucli-v0.5.0-[platform] vote
```

Start continuous voting:
```
./gurucli-v0.5.0-[platform] start
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

- **Challenge List**:
  - **Title**: Challenge name
  - **End Time**: When the challenge will end
  - **Exposure**: Your current exposure percentage
  - **Status**: Voting status (Voted/Voting/Waiting)

- **Challenge Details**:
  - **Your Progress**: Current rank, exposure, and votes
  - **Your Photos**: Your submitted photos in this challenge
  - **Boost Status**: Whether boost is available and when it will be applied

### **CLI Commands**

> **⚠️ Remember**: Only run ONE instance (GUI or CLI) at a time to avoid API rate limits.

For the CLI application, use these commands:

Login with your credentials:
```
./gurucli-v0.5.0-[platform] login
```

Run one voting cycle:
```
./gurucli-v0.5.0-[platform] vote
```

Start continuous voting:
```
./gurucli-v0.5.0-[platform] start
```

Check current status:
```
./gurucli-v0.5.0-[platform] status
```

Show help:
```
./gurucli-v0.5.0-[platform] help
```

### **Continuous Voting**

The continuous voting mode automatically runs voting cycles with dynamic interval scheduling:

- **Normal Operation**: Runs every 3 minutes (configurable via settings)
- **Within Last Threshold**: Automatically switches to higher frequency (default: 0 = disabled)
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

The app automatically saves your preferences:

- **Theme**: Light or dark mode
- **Language**: Application language selection
- **Remember Me**: Stay logged in between sessions
- **Window Position**: Remembers where you placed the app window
- **API Timeout**: Configurable timeout for API requests (1-120 seconds)
- **Voting Interval**: Customizable interval between voting cycles (1-60 minutes)
- **Last Threshold Check Frequency**: Dynamic check frequency when within last threshold (1-60 minutes, default: 0 = disabled, global setting)
- **Challenge Settings**: Per-challenge overrides for boost time, exposure, last minutes threshold, and vote only in last threshold

Settings are shared between GUI and CLI modes, so you can switch between them seamlessly.

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

- **Default Threshold**: 30 minutes (configurable)
- **Behavior**: When a challenge is within the last minutes threshold:
  - The app ignores your normal exposure threshold
  - It will vote if your exposure is below 100%
  - This helps maximize your final ranking in time-sensitive situations

### **Configuration**

You can set the Last Minutes Threshold in the app settings:

- **Global Default**: Set a default threshold for all challenges
- **Per-Challenge Override**: Set different thresholds for specific challenges
- **Range**: 1-60 minutes (recommended: 15-30 minutes)

### **Example Scenarios**

- **Competitive Challenge**: Set a longer threshold (30-60 minutes) to ensure maximum exposure
- **Less Important Challenge**: Use a shorter threshold (5-10 minutes) to conserve votes
- **High-Value Challenge**: Set to 30+ minutes to maximize your chances of ranking well
- **Multiple Challenges Ending**: Different thresholds help prioritize which challenges get votes first
- **Strategic Voting**: Combine with exposure settings to control voting patterns throughout the challenge

### **Use Cases**

- **Final Push**: Ensure you reach 100% exposure before a challenge ends
- **Vote Conservation**: Only use votes when they matter most (near the end)
- **Ranking Optimization**: Maximize your final position by voting aggressively in final minutes
- **Time Management**: Automatically adjust voting behavior as deadlines approach

## 🎯 Vote Only in Last Threshold

The Vote Only in Last Threshold feature allows you to restrict auto-voting to only occur when a challenge is within the last minutes threshold. This is useful when you want to conserve votes and only vote strategically in the final moments of a challenge.

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

## ⚡ Last Threshold Check Frequency

The Last Threshold Check Frequency feature allows you to configure different check frequencies when challenges are within the last minutes threshold. This enables more aggressive voting during critical time periods.

### **How It Works**

- **Default Setting**: 1 minute (configurable)
- **Dynamic Behavior**: The app automatically adjusts its check frequency based on challenge states:
  - **Normal Operation**: Uses the standard voting interval (default: 3 minutes)
  - **Within Last Threshold**: Uses the last threshold check frequency (default: 1 minute)
  - **Automatic Detection**: Monitors all active challenges and switches to higher frequency if any are within the last threshold

### **Configuration**

You can configure this setting in the app:

- **Global Setting**: Set the frequency for all challenges (no per-challenge overrides)
- **Range**: 0-60 minutes (0 = disabled, recommended: 1-5 minutes for last threshold)

### **Example Scenarios**

- **Normal Operation**: App checks every 3 minutes (standard voting interval)
- **Challenge within 30 minutes of ending**: App switches to checking every 1 minute (last threshold frequency)
- **Multiple challenges**: If any challenge is within the last threshold, the higher frequency applies to all
- **Challenge ends**: App automatically returns to normal frequency
- **Feature Disabled (0)**: App always uses normal voting interval regardless of challenge state

### **Use Cases**

- **Critical Timing**: More frequent checks during the final moments of challenges
- **Competitive Edge**: Maximize voting opportunities when time is limited
- **Resource Optimization**: Balance between responsiveness and API usage
- **Strategic Advantage**: Ensure votes are cast at optimal times

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