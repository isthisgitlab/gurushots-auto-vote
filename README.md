# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/workflows/Build%20and%20Release/badge.svg)](https://github.com/isthisgitlab/gurushots-auto-vote/actions)
[![Coverage](https://img.shields.io/badge/coverage-98.34%25-brightgreen)](https://github.com/isthisgitlab/gurushots-auto-vote)
[![Tests](https://img.shields.io/badge/tests-143%20passing-brightgreen)](https://github.com/isthisgitlab/gurushots-auto-vote)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

An Electron application for automated voting on GuruShots challenges. Features both a graphical interface and command-line tools for easy automation.

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

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/isthisgitlab/gurushots-auto-vote.git

# Navigate to the project directory
cd gurushots-auto-vote

# Install dependencies
npm install
```

## 🎯 Quick Start

### **GUI Mode (Recommended for beginners)**

```bash
# Start the application
npm start
```

1. **Login**: Enter your GuruShots credentials
2. **Choose Settings**: Select theme and whether to stay logged in
3. **View Challenges**: See your active challenges and voting status
4. **Start Voting**: Use the interface to manage your voting

### **CLI Mode (For automation)**

```bash
# Login with your credentials
npm run cli:login

# Run a single voting cycle
npm run cli:vote

# Start continuous voting (every 3 minutes)
npm run cli:start
```

### **Testing Mode (No real API calls)**

```bash
# Test with mock data
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
```bash
npm run cli:login      # Login with your credentials
npm run cli:vote       # Run one voting cycle
npm run cli:start      # Start continuous voting
npm run cli:status     # Check current status
npm run cli:help       # Show help
```

#### **Mock API (Testing)**
```bash
npm run mock:login     # Test login (accepts any email/password)
npm run mock:vote      # Test voting cycle
npm run mock:start     # Test continuous voting
npm run mock:status    # Check mock status
npm run mock:help      # Show mock help
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
```bash
# Clean up old log files
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

## 🧪 Testing & Coverage

This project includes a comprehensive test suite to ensure reliability and quality.

### **Running Tests**

```bash
# Run all tests
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### **Test Coverage**

Our test suite achieves excellent coverage across core components:

| Component | Statements | Branches | Functions | Lines |
|-----------|------------|----------|-----------|-------|
| **Overall** | 98.34% | 91.66% | 100% | 98.87% |
| API Client | 100% | 100% | 100% | 100% |
| Authentication | 100% | 100% | 100% | 100% |
| Challenges | 100% | 87.5% | 100% | 100% |
| Voting | 92.5% | 80% | 100% | 94.73% |
| Boost | 100% | 100% | 100% | 100% |
| Strategies | 100% | 100% | 100% | 100% |
| API Factory | 100% | 100% | 100% | 100% |

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

```bash
# Check current status
npm run cli:status

# Show help
npm run cli:help
```

## 🔒 Security

- All API calls use secure HTTPS
- Credentials are never logged
- Tokens are stored locally and securely
- No sensitive information is exposed in error messages

## 📥 Download & Install

### **Latest Release**

Download the latest version for your platform from the [Releases page](https://github.com/isthisgitlab/gurushots-auto-vote/releases).

### **Supported Platforms**

- **Windows**: NSIS installer (.exe) or portable executable
- **macOS**: DMG installer, ZIP archive, and CLI executables
- **Linux**: AppImage, DEB package, and CLI executables

### **Installation Instructions**

#### **Windows**
1. Download the `.exe` installer from the latest release
2. Run the installer and follow the setup wizard
3. Launch "GuruShots Auto Vote" from Start Menu

#### **macOS**
1. Download the `.dmg` file from the latest release
2. Open the DMG and drag the app to Applications
3. Launch from Applications folder
4. **CLI**: Download the CLI executable (`gurucli` or `gurumockcli`) and run from terminal

**Note for macOS users**: If you encounter "unidentified developer" warnings or the app won't open, you may need to remove quarantine attributes:
```bash
# For the main app
xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app

# For CLI executables (if downloaded separately)
xattr -rd com.apple.quarantine ./gurucli
xattr -rd com.apple.quarantine ./gurumockcli
```

#### **Linux**
1. **AppImage**: Download the `.AppImage` file, make it executable (`chmod +x`), and run
2. **DEB**: Download the `.deb` file and install with `sudo dpkg -i filename.deb`
3. **CLI**: Download the CLI executable (`gurucli` or `gurumockcli`), make it executable (`chmod +x`), and run

### **From Source (Developers)**

If you want to build from source or contribute:

```bash
# Clone the repository
git clone https://github.com/isthisgitlab/gurushots-auto-vote.git
cd gurushots-auto-vote

# Install dependencies
npm install

# Run tests to verify setup
npm test

# Start the application in development mode
npm run dev
```

**Requirements:**
- Node.js 18.14.0+ or 20.0.0+ or 22.0.0+ (recommended: 22.x)
- npm 8.0.0+
```

### **Development Commands**

```bash
# Development
npm run dev              # Start with hot reload and CSS watching
npm start               # Start the Electron app
npm run watch:css       # Watch CSS changes only

# Testing
npm test                # Run all tests
npm run test:watch      # Run tests in watch mode
npm run test:coverage   # Generate coverage report

# Building
npm run build:css       # Build CSS for production
npm run build           # Build for current platform
npm run build:all       # Build for all platforms

# Linting
npm run lint            # Check code style
npm run lint:fix        # Fix code style issues

# Utilities
npm run cleanup:logs    # Clean up old log files
npm run cli:help        # Show CLI help
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

**Note**: This application is for educational and development purposes. Please respect GuruShots' terms of service and use responsibly.
