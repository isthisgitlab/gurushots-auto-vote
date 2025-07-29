# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/workflows/Build%20and%20Release/badge.svg)](https://github.com/isthisgitlab/gurushots-auto-vote/actions)
[![Coverage](https://img.shields.io/badge/coverage-98.34%25-brightgreen)](https://github.com/isthisgitlab/gurushots-auto-vote)
[![Tests](https://img.shields.io/badge/tests-143%20passing-brightgreen)](https://github.com/isthisgitlab/gurushots-auto-vote)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

An Electron application for automated voting on GuruShots challenges. Features both a graphical interface and
command-line tools for easy automation.

## ☕ Support the Project

If you find this tool helpful, consider supporting its development:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`  
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

## 🚀 Features

- **Automated Voting**: Automatically vote on images in active challenges
- **Boost Management**: Apply boosts when available and near deadline
- **Dual Interface**: Use the GUI for manual control or CLI for automation
- **Secure Login**: Safe authentication with GuruShots
- **Remember Me**: Stay logged in across sessions
- **Theme Support**: Light and dark mode options
- **Mock Mode**: Test the app without real API calls
- **Comprehensive Testing**: Extensive test suite with >98% coverage

## 📥 Download & Install

### **🚀 Quick Download Links**

**Latest Version: v0.0.3**

#### **🖥️ GUI Applications (Recommended for most users)**

| Platform          | Download                                                                                                                                                             | Size   | Type                |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------|---------------------|
| **Windows**       | [📥 GuruShotsAutoVote-v0.0.3-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.0.3-x64.exe)                 | ~50 MB | Portable Executable |
| **macOS**         | [📥 GuruShotsAutoVote-v0.0.3-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.0.3-arm64.dmg)             | ~50 MB | DMG Installer       |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v0.0.3-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.0.3-x86_64.AppImage) | ~50 MB | AppImage            |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v0.0.3-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.0.3-arm64.AppImage)   | ~50 MB | AppImage            |

#### **💻 CLI Applications (For advanced users)**

| Platform              | Download                                                                                                               | Size   | Type                |
|-----------------------|------------------------------------------------------------------------------------------------------------------------|--------|---------------------|
| **macOS CLI**         | [📥 gurucli-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-mac)             | ~55 MB | Terminal Executable |
| **Linux CLI (x64)**   | [📥 gurucli-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-linux)         | ~50 MB | Terminal Executable |
| **Linux CLI (ARM64)** | [📥 gurucli-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-linux-arm) | ~47 MB | Terminal Executable |

#### **🧪 Test Mode CLI (For testing without real API calls)**

| Platform                   | Download                                                                                                                       | Size   | Type                |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------|--------|---------------------|
| **macOS Test CLI**         | [📥 gurumockcli-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurumockcli-mac)             | ~55 MB | Terminal Executable |
| **Linux Test CLI (x64)**   | [📥 gurumockcli-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurumockcli-linux)         | ~50 MB | Terminal Executable |
| **Linux Test CLI (ARM64)** | [📥 gurumockcli-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurumockcli-linux-arm) | ~47 MB | Terminal Executable |

### **📋 Installation Instructions**

#### **🪟 Windows Users**

1. **Download**: Click the Windows link above to download the `.exe` file
2. **Run**: Double-click the downloaded file to start the app
3. **No Installation Required**: The app runs directly from the executable
4. **First Run**: The app will create configuration files in your user directory

**✅ That's it!** The app is ready to use.

#### **🍎 macOS Users**

1. **Download**: Click the macOS link above to download the `.dmg` file
2. **Open DMG**: Double-click the downloaded `.dmg` file
3. **Install**: Drag the app icon to the Applications folder
4. **Launch**: Open the app from your Applications folder

**🔧 If you get security warnings:**

```bash
# Open Terminal and run this command (replace with your actual path):
xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
```

**💻 For CLI users on macOS:**

1. Download the `gurucli-mac` file
2. Open Terminal
3. Navigate to the download folder: `cd ~/Downloads`
4. Make executable: `chmod +x gurucli-mac`
5. Run: `./gurucli-mac`

#### **🐧 Linux Users**

**GUI App (AppImage):**

1. **Download**: Click the appropriate Linux link above
2. **Make Executable**: Right-click the file → Properties → Permissions → Check "Allow executing file as program"
    - Or use terminal: `chmod +x GuruShotsAutoVote-v0.0.3-*.AppImage`
3. **Run**: Double-click the file or run from terminal: `./GuruShotsAutoVote-v0.0.3-*.AppImage`

**CLI App:**

1. Download the appropriate `gurucli-linux` file
2. Open terminal and navigate to download folder: `cd ~/Downloads`
3. Make executable: `chmod +x gurucli-linux`
4. Run: `./gurucli-linux`

### **🎯 Which Version Should I Download?**

| User Type       | Recommended Download      | Why?                                |
|-----------------|---------------------------|-------------------------------------|
| **New Users**   | GUI App for your platform | Easiest to use, visual interface    |
| **Power Users** | CLI App for your platform | More control, automation features   |
| **Developers**  | CLI App + Test CLI        | Full control + testing capabilities |
| **Testing**     | Test CLI App              | Safe testing without real API calls |

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

Start the application:

```bash
npm start
```

Then follow these steps:

1. **Login**: Enter your GuruShots credentials
2. **Choose Settings**: Select theme and whether to stay logged in
3. **View Challenges**: See your active challenges and voting status
4. **Start Voting**: Use the interface to manage your voting

### **CLI Mode (For automation)**

Login with your credentials:

```bash
npm run cli:login
```

Run a single voting cycle:

```bash
npm run cli:vote
```

Start continuous voting (every 3 minutes):

```bash
npm run cli:start
```

### **Testing Mode (No real API calls)**

Test with mock data:

```bash
npm run mock:login
npm run mock:start
```

## 🔧 Usage

### **GUI Application**

The GUI provides a user-friendly interface for managing your GuruShots voting:

- **Login Screen**: Secure authentication with theme options
- **Main Interface**: View challenges, monitor voting status, and manage settings
- **Settings**: All preferences are automatically saved

### **CLI Commands**

#### **Real API (Production)**

Login with your credentials:

```bash
npm run cli:login
```

Run one voting cycle:

```bash
npm run cli:vote
```

Start continuous voting:

```bash
npm run cli:start
```

Check current status:

```bash
npm run cli:status
```

Show help:

```bash
npm run cli:help
```

#### **Mock API (Testing)**

Test login (accepts any email/password):

```bash
npm run mock:login
```

Test voting cycle:

```bash
npm run mock:vote
```

Test continuous voting:

```bash
npm run mock:start
```

Check mock status:

```bash
npm run mock:status
```

Show mock help:

```bash
npm run mock:help
```

### **Continuous Voting**

The continuous voting mode automatically runs voting cycles every 3 minutes:

```bash
npm run cli:start
```

## 📝 Logging

The application uses a split logging system with automatic retention:

### **Log Files**

- **`errors-YYYY-MM-DD.log`** - Error logs (30 days retention)
- **`app-YYYY-MM-DD.log`** - General application logs (7 days retention)
- **`api-YYYY-MM-DD.log`** - API request/response logs (dev mode only, 1 day retention)

### **Log Locations**

- **macOS**: `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Windows**: `%APPDATA%/gurushots-auto-vote/logs/`
- **Linux**: `~/.config/gurushots-auto-vote/logs/`

### **Cleanup**

Clean up old log files:

```bash
npm run cleanup:logs
```

### **Development vs Production**

- **Development mode**: All log types are written
- **Production mode**: API logs are disabled to reduce disk usage

### **Automatic Cleanup**

The logging system includes automatic cleanup to prevent disk space issues:

- **Startup cleanup**: Runs when the application starts (GUI or CLI)
- **Periodic cleanup**: Runs every hour while the application is running
- **Daily rotation**: Creates new log files each day with date-based naming
- **Date-based cleanup**: Automatically deletes log files based on retention periods
- **Size-based cleanup**: Automatically deletes log files that exceed size limits:
    - `errors-YYYY-MM-DD.log`: 10 MB max
    - `app-YYYY-MM-DD.log`: 50 MB max
    - `api-YYYY-MM-DD.log`: 20 MB max
- **Manual cleanup**: Available via `npm run cleanup:logs`

**Example Output:**

```
=== Starting Continuous Voting Mode ===
Mode: REAL API
Stay logged in: Yes
Scheduling voting every 3 minutes

--- Voting Cycle 1 ---
Getting active challenges
Found 3 active challenges
Processing challenge: Street Photography
Boost applied successfully
Votes submitted successfully
--- Voting Cycle 1 Completed ---
```

Press `Ctrl+C` to stop continuous voting.

## ⚙️ Settings

The app automatically saves your preferences:

- **Theme**: Light or dark mode
- **Remember Me**: Stay logged in between sessions
- **Window Position**: Remembers where you placed the app window
- **Authentication**: Securely stores your login token

Settings are shared between GUI and CLI modes, so you can switch between them seamlessly.

## 🔍 Troubleshooting

### **Common Issues**

**"No authentication token found"**

```bash
npm run cli:login
```

**"Network Error"**

- Check your internet connection
- Try again later

**"Token expired"**

```bash
npm run cli:login
```

**Windows open off-screen**

```bash
npm run cli:reset-windows
```

### **Get Help**

Check current status:

```bash
npm run cli:status
```

Show help:

```bash
npm run cli:help
```

## 🔒 Security

- All API calls use secure HTTPS
- Credentials are never logged
- Tokens are stored locally and securely
- No sensitive information is exposed in error messages

## 🧪 Testing & Coverage

This project includes a comprehensive test suite to ensure reliability and quality.

### **Running Tests**

Run all tests:

```bash
npm test
```

Run tests in watch mode (for development):

```bash
npm run test:watch
```

Run tests with coverage report:

```bash
npm run test:coverage
```

### **Test Coverage**

Our test suite achieves excellent coverage across core components:

| Component      | Statements | Branches | Functions | Lines  |
|----------------|------------|----------|-----------|--------|
| **Overall**    | 98.34%     | 91.66%   | 100%      | 98.87% |
| API Client     | 100%       | 100%     | 100%      | 100%   |
| Authentication | 100%       | 100%     | 100%      | 100%   |
| Challenges     | 100%       | 87.5%    | 100%      | 100%   |
| Voting         | 92.5%      | 80%      | 100%      | 94.73% |
| Boost          | 100%       | 100%     | 100%      | 100%   |
| Strategies     | 100%       | 100%     | 100%      | 100%   |
| API Factory    | 100%       | 100%     | 100%      | 100%   |

### **What's Tested**

- ✅ **API Layer**: HTTP client, authentication, challenges, voting, boost functionality
- ✅ **Strategy Pattern**: Mock and real API implementations
- ✅ **Error Handling**: Network failures, invalid responses, authentication errors
- ✅ **Mock System**: Simulated API responses for testing and development
- ✅ **Edge Cases**: Empty data, null responses, malformed inputs

### **Mock Testing**

All tests use mocked HTTP requests to ensure:

- **No real API calls** during testing
- **Fast test execution** (no network dependencies)
- **Predictable results** for reliable CI/CD
- **Safe testing** without affecting your GuruShots account

### **Continuous Integration**

Tests run automatically on every push and pull request:

- **Linting** ensures code quality standards
- **Unit tests** verify individual component functionality
- **Coverage reports** maintain quality thresholds
- **Build verification** ensures deployable artifacts

## 📦 Installation (From Source)

### **From Source (Developers)**

If you want to build from source or contribute:

Clone the repository:

```bash
git clone https://github.com/isthisgitlab/gurushots-auto-vote.git
cd gurushots-auto-vote
```

Install dependencies:

```bash
npm install
```

Run tests to verify setup:

```bash
npm test
```

Start the application in development mode:

```bash
npm run dev
```

**Requirements:**

- Node.js 18.14.0+ or 20.0.0+ or 22.0.0+ (recommended: 22.x)
- npm 8.0.0+

### **Development Commands**

Development:

```bash
npm run dev
npm start
npm run watch:css
```

Testing:

```bash
npm test
npm run test:watch
npm run test:coverage
```

Building:

```bash
npm run build:css
npm run build
npm run build:all
```

Linting:

```bash
npm run lint
npm run lint:fix
```

Utilities:

```bash
npm run cleanup:logs
npm run cli:help
```

## 📄 License

This project is licensed under the ISC License.

## 🆘 Support

For issues and questions:

1. Check the troubleshooting section above
2. Use the help commands: `npm run cli:help`
3. Check status: `npm run cli:status`
4. Open an issue on GitHub

---

**Note**: This application is for educational and development purposes. Please respect GuruShots' terms of service and
use responsibly.