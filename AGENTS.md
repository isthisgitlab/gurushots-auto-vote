# Development Guidelines

> `AGENTS.md` and `CLAUDE.md` are hardlinked — editing either updates both. Use a single editor session per change; don't try to keep two divergent copies.

## Code Architecture

- **MCP Integration**: Always utilize MCP (Model Context Protocol) tools and resources first before implementing custom logic. Check available MCP servers for existing solutions.
- **Cross-Platform Consistency**: The application targets three platforms — Electron (GUI), CLI, and Android (Capacitor). All core business logic in `src/js/` must be shared; only the platform shell (entry points, transport, storage adapter) is platform-specific.
- **Entry points**: Electron `src/js/index.js` · CLI `src/js/cli/cli.js` · Electron preload `src/js/preload.js` · Capacitor bridge `src/js/bridge/capacitor.js`. The same React renderer (`src/js/react/`) runs under both Electron and Capacitor.
- **API surface swap**: `src/js/apiFactory.js` selects real vs mock implementations at runtime based on `settings.mock`. All callers go through the factory — do not import `src/js/api/*` or `src/js/mock/*` directly from business logic.

## File Management

- **Documentation Policy**: Do not create markdown files, README files, or other documentation unless explicitly requested by the user.
- **Prefer Editing**: Always edit existing files rather than creating new ones when possible.

## Testing Standards

- **Test Organization**: All test files must be placed in the `tests/` directory following proper Jest conventions and structure.
- **Mock Configuration**: Never use `mock: false` in any Jest or testing commands - use proper mocking strategies instead.

## UI/UX Standards

- **Styling Framework**: GUI application uses Tailwind CSS + DaisyUI for all styling components
- **Custom CSS Policy**: No custom CSS is allowed except for the predefined Latvian color theme (already defined in the project)
- **Component Consistency**: Follow DaisyUI component patterns and conventions for consistent user experience

## Code Quality

- **DRY Principle**: Prioritize code reuse over duplication. Extract common functionality into shared utilities, hooks, or components
- **Shared Logic**: Create reusable functions and modules that can be utilized across both Electron and CLI implementations

## Configuration Management

- **Settings Architecture**: Settings facade lives at `src/js/settings.js`. Schema (keys + defaults + validation) is in `src/js/settings/schema.js`; persistence transport (fs on Electron/CLI, `@capacitor/preferences` on Android) is in `src/js/settings/storage.js`. Always go through the facade.
- **Environment Variables**: Do not use environment variables (.env files) for application configuration - use the established settings logic instead
- **Configuration Consistency**: Ensure settings are accessible and consistent between GUI and CLI interfaces

## Key Commands

- **Dev (GUI + watchers)**: `npm run dev` — runs CSS, React, and Electron watchers concurrently
- **CLI**: `npm run cli:start` · `cli:vote` · `cli:status` · `cli:login` · `cli:help`
- **Build**: `npm run build:mac` · `build:win` · `build:linux` · `build:android` · `build:cli:all`
- **CLI build prereq**: needs `strip` (preinstalled on Linux + Xcode CLT) and, on macOS, `codesign` (Xcode CLT). UPX is intentionally NOT used — macOS AMFI rejects packed Mach-O, and postject's ELF section injection trips UPX's `bad e_phoff` structural check on Linux. Mac CLI binary is ad-hoc signed by the build — no Developer ID / notarization, so browser-downloaded copies still hit Gatekeeper and need `xattr -d com.apple.quarantine`.
- **Settings (dev)**: `npm run settings:get` · `settings:set <key> <value>` · `settings:schema` · `settings:reset`
- **Tests**: `npm test` (full suite) · `npm run test:watch` · `npm run test:coverage` — Jest has two projects (`node` and `jsdom`); React tests are `.test.jsx` under `tests/react/`, everything else is `.test.js`
- **Lint/format**: `npm run lint` · `lint:fix` · `format` (Prettier)
- **README version sync**: `npm run verify:readme` ensures README version strings match `package.json`. `npm run update:readme` rewrites them. The release workflow enforces this — drift will fail CI.

## Git Operations

- **Push Restrictions**: Never push changes to remote repositories under any circumstances. All git operations must remain local only.
- **Commit Policy**: Adding commits and performing git read operations (status, log, diff, etc.) are permitted and encouraged for development workflow.
- **File Reset Prohibition**: Never use `git checkout` to reset or revert files under any circumstances. This includes avoiding commands like `git checkout -- <file>` or `git checkout HEAD <file>`.
- **Branch Operations**: Local branch operations are allowed, but all changes must remain in the local repository.
- **Safe Git Commands**: Stick to read-only git commands (status, log, diff, show) and local commit operations only.

## Development Commands

- **Linting**: Run `npm run lint` after code changes (JavaScript project - no TypeScript)
- **Testing**: Use proper Jest test commands as defined in package.json
- **Testing Completion**: All tests must pass regardless of code changes (even if they are not related to the code being changed)
- **Logger**: Use `require('./logger')` (from `src/js/logger.js`). Prefer category-scoped logging: `logger.withCategory('voting').info(msg, data)`. Never use `console.log` — fallback to `console.*` only in bootstrap code where the logger module is genuinely unavailable.
