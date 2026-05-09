# Contributing to GuruShots Auto Vote

Thank you for your interest in contributing to GuruShots Auto Vote! We welcome contributions from the community.

## 🚀 Getting Started

### Prerequisites

- Node.js 24+ (matches `package.json` `engines.node` and `.nvmrc`; CI builds also pin to 24)
- npm 8+ (comes with Node.js)

### Setup

1. Fork the repository
2. Clone your fork:
    ```bash
    git clone https://github.com/your-username/gurushots-auto-vote.git
    cd gurushots-auto-vote
    ```
3. Install dependencies:
    ```bash
    npm install
    ```
4. Start development:
    ```bash
    npm run dev
    ```

## 🛠️ Development

### Available Scripts

- `npm start` - Run the Electron app
- `npm run dev` - Development mode with hot reload
- `npm run lint` - Check code style
- `npm run lint:fix` - Fix code style issues
- `npm run verify:settings` - Verify settings functionality
- `npm run verify:challenges` - Test challenges loading
- `npm run debug:environment` - Debug environment detection
- `npm run update:readme` - Update README.md with current version from package.json
- `npm run verify:readme` - Verify README.md matches package.json version

### Project Structure

```
src/
├── js/
│   ├── api/          # Real API modules for GuruShots integration
│   ├── cli/          # Command-line interface (cli.js, mock-cli.js)
│   ├── mock/         # Mock API for testing
│   ├── services/     # Base services (middleware, etc.)
│   ├── strategies/   # API strategy implementations (real/mock)
│   ├── interfaces/   # Abstract interfaces for strategies
│   ├── apiFactory.js # Factory for switching between real/mock APIs
│   ├── app.js        # Main renderer process
│   ├── index.js      # Main electron process
│   └── preload.js    # Preload script for security
├── html/             # HTML templates
├── styles/           # CSS styles (Tailwind)
└── assets/           # Images and other assets

scripts/              # Development and build utilities
├── verify-settings.js    # Verify settings functionality
├── verify-challenges.js  # Test challenges loading
├── verify-login.js       # Test authentication
├── debug-environment.js  # Debug environment detection
├── debug-window-bounds.js # Test window positioning
├── cleanup-logs.js       # Log cleanup utility
├── update-readme-version.js # Update README with current version
├── verify-readme-version.js # Verify README version matches package.json
└── dev.js               # Development server
```

### Architecture

The application uses a **Strategy Pattern** for API handling:

- **`apiFactory.js`** - Factory that switches between real and mock APIs based on settings
- **`interfaces/ApiStrategy.js`** - Abstract interface that all API strategies must implement
- **`strategies/RealApiStrategy.js`** - Real API implementation using actual GuruShots endpoints
- **`strategies/MockApiStrategy.js`** - Mock API implementation for testing without real API calls
- **`services/BaseMiddleware.js`** - Common middleware logic shared between real and mock implementations

This eliminates code duplication and provides clean separation between real and mock functionality.

## 📝 Code Guidelines

### Code Style

- We use ESLint for code linting
- 4-space indentation
- Single quotes for strings
- Semicolons are required
- Always run `npm run lint` before committing

### Security

- Never expose API keys or credentials
- Use context isolation and preload scripts
- Follow Electron security best practices
- No `nodeIntegration` in renderer processes

### Git Workflow

1. Create a feature branch from `master`:
    ```bash
    git checkout -b feature/your-feature-name
    ```
2. Make your changes
3. Run linting and tests:
    ```bash
    npm run lint
    npm run test
    ```
4. **Important**: If you changed the version in package.json, update the README:
    ```bash
    npm run update:readme
    ```
5. Commit with clear messages:
    ```bash
    git commit -m "feat: add new voting feature"
    ```
6. Push and create a pull request

### README Maintenance

The README.md file contains download links and version information that must stay in sync with the package.json version:

- **Before committing**: Run `npm run verify:readme` to check if README is up to date
- **After version changes**: Run `npm run update:readme` to update all version references
- **CI/CD**: The build process automatically verifies and updates the README
- **Manual updates**: If you manually edit download links, ensure they match the current version

### Commit Messages

We follow conventional commit format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Maintenance tasks

## 🐛 Bug Reports

When reporting bugs, please include:

- Operating system and version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Screenshots (if applicable)
- Log files (check `logs/` directory)

## 💡 Feature Requests

Before suggesting new features:

- Check existing issues and discussions
- Consider if it aligns with the project goals
- Provide clear use cases and benefits

## 🔄 Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all existing tests pass
4. Run linting and fix any issues
5. Update README.md if needed
6. Provide clear PR description

### PR Checklist

- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] No breaking changes (or clearly documented)

## 🧪 Development Utilities

### Verification Scripts

Test specific functionality without the full app:

```bash
# Verify core functionality
npm run verify:settings     # Test settings system
npm run verify:challenges   # Test challenges loading
npm run verify:login        # Test authentication

# Debug utilities
npm run debug:environment   # Check environment detection
npm run debug:window-bounds # Test window positioning
```

### Mock Mode Testing

Test your changes without real API calls:

```bash
npm run mock:start
```

### Manual Testing

- Test both GUI and CLI modes
- Verify on different platforms
- Check error handling
- Test with invalid credentials
- Run verification scripts after changes

## 📦 Building

### Local Build

```bash
npm run build
```

### Platform-Specific Builds

```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

## 🤝 Code of Conduct

- Be respectful and inclusive
- Help others learn and grow
- Focus on constructive feedback
- Respect project maintainers' decisions

## 📞 Getting Help

- Open an issue for bugs or questions
- Check existing documentation
- Review closed issues for similar problems

## 🎉 Recognition

Contributors will be recognized in:

- Release notes
- README.md contributors section
- Git commit history

Thank you for contributing! 🚀
