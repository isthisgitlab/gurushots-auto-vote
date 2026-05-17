# Contributing to GuruShots Auto Vote

Thank you for your interest in contributing to GuruShots Auto Vote! We welcome contributions from the community.

## 🚀 Getting Started

### Prerequisites

- Node.js 26+ (matches `package.json` `engines.node` and `.nvmrc`; CI builds also pin to 26)
- pnpm 11+ (installed automatically via `corepack enable` — Node ships with corepack)

### Setup

1. Fork the repository
2. Clone your fork:
    ```bash
    git clone https://github.com/your-username/gurushots-auto-vote.git
    cd gurushots-auto-vote
    ```
3. Install dependencies:
    ```bash
    pnpm install
    ```
4. Start development:
    ```bash
    pnpm dev
    ```
    `pnpm dev` runs Tailwind, esbuild, and `electronmon` together. Stop the session with `Ctrl+C` in the terminal — closing the Electron window restarts the app rather than ending the session.

## 🛠️ Development

### Available Scripts

- `pnpm start` - Run the Electron app
- `pnpm dev` - Development mode with hot reload
- `pnpm lint` - Check code style
- `pnpm lint:fix` - Fix code style issues
- `pnpm update:readme` - Update README.md with current version from package.json
- `pnpm verify:readme` - Verify README.md matches package.json version

### Project Structure

```
src/
├── js/
│   ├── api/          # Real GuruShots API client modules
│   ├── bridge/       # Capacitor bridge (Android shell)
│   ├── cli/          # CLI entry point and per-command modules
│   ├── ipc/          # Electron IPC handlers
│   ├── mock/         # Mock API counterparts to src/js/api/*
│   ├── react/        # React renderer (shared by Electron and Capacitor)
│   ├── scheduling/   # Cron / interval scheduling
│   ├── services/     # Shared voting & middleware logic
│   ├── settings/     # Schema, validation, and storage transport
│   ├── translations/ # i18n strings (en, lv)
│   ├── ui/           # UI helpers used by the renderer
│   ├── voting/       # Vote orchestration entry
│   ├── windows/      # Electron window lifecycle
│   ├── apiFactory.js # Selects real vs mock at runtime (settings.mock)
│   ├── index.js      # Electron main process entry
│   ├── login.js      # Auth flow shared by GUI/CLI
│   ├── logger.js     # Category-scoped logger
│   ├── metadata.js   # App metadata helpers
│   ├── preload.js    # Electron preload (context isolation)
│   ├── runtime.js    # Platform detection helpers
│   └── settings.js   # Settings facade (use this, not the transport directly)
├── html/             # HTML templates
├── styles/           # CSS styles (Tailwind + DaisyUI)
└── assets/           # Images and other assets

scripts/              # Development and build utilities
├── build-cli.js          # Bundle CLI and inject into Node SEA binary
├── build-react.js        # esbuild orchestration for the React renderer
├── cleanup-logs.js       # Delete legacy api-debug-* log files
├── readme-version.js     # Sync (or verify with --check) README/INSTALACIJA version strings
├── settings-cli.js       # Settings facade CLI used by the settings:* pnpm scripts
└── syntax-check.js       # Lightweight node-context syntax check (used by `pnpm lint`)
```

### Architecture

The same core business logic in `src/js/` runs under three shells: **Electron (GUI)**, **CLI**, and **Capacitor (Android)**. Only the entry points, transport, and storage adapter are platform-specific.

- **Entry points**: Electron `src/js/index.js` · CLI `src/js/cli/cli.js` · Electron preload `src/js/preload.js` · Capacitor bridge `src/js/bridge/capacitor.js`
- **React renderer** (`src/js/react/`) is shared between Electron and Capacitor
- **`apiFactory.js`** selects real vs mock API implementations at runtime based on `settings.mock`. All business logic goes through the factory — do not import from `src/js/api/*` or `src/js/mock/*` directly
- **Settings facade** lives at `src/js/settings.js`. Schema + defaults + validation are in `src/js/settings/schema.js`; persistence transport (fs on Electron/CLI, `@capacitor/preferences` on Android) is in `src/js/settings/storage.js`

## 📝 Code Guidelines

### Code Style

- We use ESLint for code linting
- 4-space indentation
- Single quotes for strings
- Semicolons are required
- Always run `pnpm lint` before committing

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
    pnpm lint
    pnpm test
    ```
4. **Important**: If you changed the version in package.json, update the README:
    ```bash
    pnpm update:readme
    ```
5. Commit with clear messages:
    ```bash
    git commit -m "feat: add new voting feature"
    ```
6. Push and create a pull request

### README Maintenance

The README.md file contains download links and version information that must stay in sync with the package.json version:

- **Before committing**: Run `pnpm verify:readme` to check if README is up to date
- **After version changes**: Run `pnpm update:readme` to update all version references
- **CI/CD**: The release workflow runs `update:readme` then `verify:readme` before tagging — it does NOT run on every build, so don't rely on it to catch local drift
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

### Mock Mode Testing

Mock mode is selected via the in-app setting (`mock: true`) and routes all API traffic through `src/js/mock/*`. See `src/js/apiFactory.js` for the swap point. Start the app normally (`pnpm dev` or `pnpm cli:start`) with mock mode enabled in settings to exercise it.

### Manual Testing

- Test both GUI and CLI modes
- Verify on different platforms
- Check error handling
- Test with invalid credentials
- Run verification scripts after changes

## 📦 Building

### Local Build

```bash
pnpm build
```

### Platform-Specific Builds

```bash
pnpm build:win    # Windows
pnpm build:mac    # macOS
pnpm build:linux  # Linux
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
