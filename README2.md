# GuruShots Auto Voter

An Electron application for automated voting on GuruShots challenges. Features both a graphical interface and command-line tools for easy automation.

## 🚀 Features

- **Automated Voting**: Automatically vote on images in active challenges
- **Boost Management**: Apply boosts when available and near deadline
- **Dual Interface**: Use the GUI for manual control or CLI for automation
- **Secure Login**: Safe authentication with GuruShots
- **Remember Me**: Stay logged in across sessions
- **Theme Support**: Light and dark mode options
- **Mock Mode**: Test the app without real API calls

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
npm run mock:login     # Test login (uses test credentials)
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

# Start the application
npm start
```

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section above
2. Use the help commands: `npm run cli:help`
3. Check status: `npm run cli:status`
4. Open an issue on GitHub

---

**Note**: This application is for educational and development purposes. Please respect GuruShots' terms of service and use responsibly.
