# 🎯 GuruShots Auto Vote

**Modern desktop application for automated GuruShots voting with CLI bonus**

[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-blue)](https://github.com/isthisgitlab/gurushots-auto-vote/releases)

## ✨ Key Features

### 🖥️ **Modern Desktop GUI**
- **Beautiful UI**: Electron app with TailwindCSS and DaisyUI components
- **Real-time monitoring**: Live challenge updates and voting progress
- **Interactive settings**: Visual configuration for all voting parameters
- **Challenge management**: Per-challenge customization with overrides
- **Theme support**: Light/dark mode with customizable appearance

### 🔄 **Smart Voting System**
- **Per-challenge settings**: Customize exposure thresholds, boost times, and voting strategies
- **Intelligent timing**: Vote only in last minutes or apply boosts strategically
- **Continuous operation**: Automated voting with background scheduling
- **Real-time monitoring**: Live status updates and voting progress

### 🛡️ **Development & Testing**
- **Mock mode**: Simulate API calls for safe testing and development
- **Real mode**: Production-ready with actual GuruShots API integration
- **Easy switching**: Toggle between modes via GUI settings or CLI login

### ⚙️ **Advanced Configuration**
- **Global defaults**: Set default values for all challenges
- **Challenge overrides**: Per-challenge customizations
- **Timezone support**: Handle different time zones for challenge deadlines
- **Multi-language**: Internationalization support

## 🚀 Usage Examples

```bash
# GUI - Launch desktop application (main interface)
npm start

# CLI - Bonus command-line interface
npm run cli:status    # Check status and mode
npm run cli:login     # Interactive login with mode selection
npm run cli:start     # Start continuous voting
```

## 🏗️ Architecture

- **Electron App**: Modern desktop application with web technologies
- **Strategy Pattern**: Clean separation between real and mock APIs
- **Middleware Layer**: Unified interface for both GUI and CLI
- **Settings Management**: Centralized configuration with schema validation
- **Test Coverage**: Comprehensive test suite with 97.8% coverage

## 📦 Platforms

- **macOS**: Native desktop app (.dmg) + CLI binary
- **Linux**: AppImage + CLI binary (x64 & ARM64)
- **Windows**: Portable executable (.exe) + CLI binary

## 🔧 Tech Stack

- **Frontend**: Electron, TailwindCSS, DaisyUI
- **Backend**: Node.js, Express-style API layer
- **CLI Bonus**: Command-line interface with interactive features
- **Testing**: Jest with comprehensive coverage
- **Build**: Electron Builder, pkg for CLI binaries

---

**[📥 Download Latest Release](https://github.com/isthisgitlab/gurushots-auto-vote/releases)** | **[📚 Full Documentation](https://github.com/isthisgitlab/gurushots-auto-vote)** 