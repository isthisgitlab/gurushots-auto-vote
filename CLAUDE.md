# Development Guidelines

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

> Package manager: **pnpm 11+** (pinned via `packageManager` in `package.json`, bootstrap with `corepack enable`). Use `pnpm <script>` everywhere — the `npm` CLI is not supported.

- **Dev (GUI + watchers)**: `pnpm dev` — runs CSS, React, and Electron watchers concurrently
- **CLI**: `pnpm cli:start` · `cli:vote` · `cli:status` · `cli:login` · `cli:help`
- **Build**: `pnpm build:mac` · `build:win` · `build:linux` · `build:android` · `build:cli:all`
- **CLI build prereq**: needs `strip` (preinstalled on Linux + Xcode CLT) and, on macOS, `codesign` (Xcode CLT). Each CLI target is built on its native-arch runner — mac on `macos-26`, linux x64 on `ubuntu-latest`, linux arm64 on `ubuntu-24.04-arm` (separate `build-cli-arm` job). Local cross-arch builds (e.g. `build:cli:linux-arm` from an x64 host) aren't supported by the script — run on matching hardware or let CI handle it. UPX is intentionally NOT used — macOS AMFI rejects packed Mach-O, and postject's ELF section injection trips UPX's `bad e_phoff` structural check on Linux. Mac CLI binary is ad-hoc signed by the build — no Developer ID / notarization, so browser-downloaded copies still hit Gatekeeper and need `xattr -d com.apple.quarantine`.
- **Settings (dev)**: `pnpm settings:get` · `settings:set <key> <value>` · `settings:schema` · `settings:reset`
- **Tests**: `pnpm test` (full suite) · `pnpm test:watch` · `pnpm test:coverage` — Jest has two projects (`node` and `jsdom`); React tests are `.test.jsx` under `tests/react/`, everything else is `.test.js`
- **Lint/format/types**: `pnpm lint` · `lint:fix` · `format` (Prettier) · `typecheck` (tsc, checker-only — see **Dependencies & Type Checking**)
- **README version sync**: `pnpm verify:readme` ensures README version strings match `package.json`. `pnpm update:readme` rewrites them. The release workflow enforces this — drift will fail CI.

## Dependencies & Type Checking

- **Pre-release pins are intentional**: `prettier` is a true pre-release (`4.0.0-alpha`); `electron-builder` and `electron-updater` sit on versions published under the `next` dist-tag that are _ahead_ of the stable `latest` tag. Do **not** "downgrade" them to `latest`, and don't merge a bot PR that does. Everything else stays on the exact latest stable.
- **Automated updates**: Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm + github-actions; majors (incl. `github/codeql-action`) land as individual PRs. It never downgrades and only offers pre-release bumps for deps already on a pre-release, so the pins above are preserved. The manual `pnpm bump` (npm-check-updates) still works for ad-hoc bumps.
- **Build-script approval**: pnpm 11 requires opting each native postinstall script into `allowBuilds:` in `pnpm-workspace.yaml`. Keep that list minimal — every entry is an arbitrary-code-execution opportunity.
- **Type checking** (`pnpm typecheck` → `tsc --noEmit`): this is a JavaScript project — TypeScript is a **checker only, never a compiler** (`tsconfig.json` sets `noEmit` + `checkJs: false`). Only files with a `// @ts-check` comment are type-checked, so add JSDoc + `// @ts-check` to the shared core incrementally. Seeded so far: `apiFactory.js`, `settings/schema.js`, `services/VotingLogic.js`. CI gates on it. When a `// @ts-check` file imports an un-typed module whose inferred signature is too narrow (e.g. a `= null` default), cast the import to `any` at the boundary until that module is typed too.
- **Pre-commit hooks**: `lefthook` (`lefthook.yml`, installed by the `prepare` script) runs `eslint --fix` + `prettier --write` on staged files only, and re-stages what it fixes (`stage_fixed`) so the fix lands in the same commit — note this re-stages whole files, not partial `git add -p` hunks. Full tests stay in CI. An `--ignore-scripts` install skips hook setup; run `pnpm exec lefthook install` manually if so.
- **CI security gate**: `pnpm audit --prod --audit-level=high` (shipped deps only) runs in the test workflow; CodeQL (`.github/workflows/codeql.yml`) scans on push/PR and weekly.

## Git Operations

- **Push Restrictions**: Never push changes to remote repositories under any circumstances. All git operations must remain local only.
- **Commit Policy**: Adding commits and performing git read operations (status, log, diff, etc.) are permitted and encouraged for development workflow.
- **File Reset Prohibition**: Never use `git checkout` to reset or revert files under any circumstances. This includes avoiding commands like `git checkout -- <file>` or `git checkout HEAD <file>`.
- **Branch Operations**: Local branch operations are allowed, but all changes must remain in the local repository.
- **Safe Git Commands**: Stick to read-only git commands (status, log, diff, show) and local commit operations only.

## Development Commands

- **Linting & types**: Run `pnpm lint` and `pnpm typecheck` after code changes. JavaScript project — `tsc` runs as a checker only on `// @ts-check`-opted files (see **Dependencies & Type Checking**).
- **Testing**: Use proper Jest test commands as defined in package.json
- **Testing Completion**: All tests must pass regardless of code changes (even if they are not related to the code being changed)
- **Logger**: Use `require('./logger')` (from `src/js/logger.js`). Prefer category-scoped logging: `logger.withCategory('voting').info(msg, data)`. Never use `console.log` — fallback to `console.*` only in bootstrap code where the logger module is genuinely unavailable.
