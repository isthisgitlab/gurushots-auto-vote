# Contributing to GuruShots Auto Vote

Thank you for your interest in contributing to GuruShots Auto Vote! We welcome contributions from the community.

## 🚀 Getting Started

### Prerequisites

- Node.js 26+ (matches `package.json` `engines.node` and `.nvmrc`; CI builds also pin to 26)
- pnpm 12+. The repo pins the exact version via the `packageManager` field in `package.json`; enable [corepack](https://nodejs.org/api/corepack.html) to use it:
    ```bash
    corepack enable
    ```
    Corepack ships with the official Node.js installer (nodejs.org). On some Linux distros (Debian/Ubuntu via apt, Fedora/RHEL, Arch) it may be packaged separately or absent — if `corepack: command not found`, install it with `npm i -g corepack` and re-run `corepack enable`. The repo also enables `engineStrict` in `pnpm-workspace.yaml`, so any package whose `engines.node` doesn't satisfy Node 26+ will fail to install — that's intentional.

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
    `pnpm dev` runs Tailwind, esbuild, the main-process bundle watcher and `electronmon` together. Stop the session with `Ctrl+C` in the terminal — closing the Electron window restarts the app rather than ending the session.

## 🛠️ Development

### Available Scripts

- `pnpm start` - Build the main-process bundle and run the Electron app
- `pnpm dev` - Development mode with hot reload
- `pnpm lint` - Check code style
- `pnpm lint:fix` - Fix code style issues
- `pnpm update:readme` - Update README.md with current version from package.json
- `pnpm verify:readme` - Verify README.md matches package.json version

### Project Structure

```
src/
├── ts/
│   ├── api/          # Real GuruShots API client modules
│   ├── bridge/       # Capacitor bridge (Android shell)
│   ├── cli/          # CLI entry point and per-command modules
│   ├── ipc/          # Electron IPC handlers
│   ├── mock/         # Mock API counterparts to src/ts/core/api/*
│   ├── react/        # React renderer (shared by Electron and Capacitor)
│   ├── scheduling/   # Cron / interval scheduling
│   ├── services/     # Shared voting & middleware logic
│   ├── settings/     # Schema, validation, and storage transport
│   ├── translations/ # i18n strings (en, lv)
│   ├── ui/           # UI helpers used by the renderer
│   ├── voting/       # Vote orchestration entry
│   ├── windows/      # Electron window lifecycle
│   ├── apiFactory.ts # Selects real vs mock at runtime (settings.mock)
│   ├── index.ts      # Electron main process entry
│   ├── logger.ts     # Category-scoped logger
│   ├── metadata.ts   # App metadata helpers
│   ├── preload.ts    # Electron preload (context isolation)
│   ├── runtime.ts    # Platform detection helpers
│   └── settings.ts   # Settings facade (use this, not the transport directly)
├── html/             # HTML templates
├── styles/           # CSS styles (Tailwind + DaisyUI)
└── assets/           # Images and other assets

scripts/              # Development and build utilities
├── build-cli.ts          # Bundle CLI and inject into Node SEA binary
├── build-react.ts        # esbuild orchestration for the React renderer
├── cleanup-logs.ts       # Delete api-debug-* log files from the userData logs dir
├── readme-version.ts     # Sync (or verify with --check) README/README.lv version strings
└── settings-cli.ts       # Settings facade CLI used by the settings:* pnpm scripts
```

### Architecture

The same core business logic in `src/ts/` runs under three shells: **Electron (GUI)**, **CLI**, and **Capacitor (Android)**. Only the entry points, transport, and storage adapter are platform-specific.

- **Entry points**: Electron `src/ts/shells/electron/index.ts` (bundled into `out/main/app.js` by `scripts/build-main.ts`, loaded through `out/main/index.js`) · CLI `src/ts/shells/cli/cli.ts` · Electron preload `src/ts/shells/electron/preload.ts` · Capacitor bridge `src/ts/shells/capacitor/bridge/capacitor.ts`
- **React renderer** (`src/ts/react/`) is shared between Electron and Capacitor
- **`apiFactory.ts`** selects real vs mock API implementations at runtime based on `settings.mock`. All business logic goes through the factory — do not import from `src/ts/core/api/*` or `src/ts/core/mock/*` directly
- **Settings facade** lives at `src/ts/core/settings.ts`. Schema + defaults + validation are the facade `src/ts/core/settings/schema.ts` over the modules in `src/ts/core/settings/schema/`; persistence transport (fs on Electron/CLI, `@capacitor/preferences` on Android) is in `src/ts/core/settings/storage.ts`

## 📝 Code Guidelines

### Code Style

- We use Oxlint for code linting and Prettier for formatting
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

Mock mode is selected via the in-app setting (`mock: true`) and routes all API traffic through `src/ts/core/mock/*`. See `src/ts/core/apiFactory.ts` for the swap point. Start the app normally (`pnpm dev` or `pnpm cli:start`) with mock mode enabled in settings to exercise it.

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

The first build needs network access: it downloads the pinned SigLIP image model (~200 MB, sha256-verified)
into `.cache/vision-model/`, which every GUI, Android, and CLI build bundles for the auto-fill visual check.
Later builds reuse the cache offline.

## 🤝 Code of Conduct

This project follows the [Contributor Covenant 3.0](CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.

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

## Agent development reference

### Development command reference

> Package manager: **pnpm 12+** (pinned via `packageManager` in `package.json`, bootstrap with `corepack enable`). Use `pnpm <script>` everywhere — the `npm` CLI is not supported.

- **Dev (GUI + watchers)**: `pnpm dev` — runs CSS, React, main-process bundle and Electron (electronmon) watchers concurrently; a core edit rebuilds `out/main/app.js` and electronmon restarts the app
- **CLI**: `pnpm cli:start` · `cli:vote` · `cli:status` · `cli:login` · `cli:help`
- **Running TypeScript under Node**: every npm script that runs `src/` or `scripts/` code (`cli:*`, `settings:*`, `build:*`, `size*`, the lexicon and readme scripts, …) runs as `node --import tsx scripts/….ts`; tsx compiles the ESM-syntax TypeScript to CommonJS for this `"type": "commonjs"` package, so `require.main`, `module` and `__dirname` keep working. A new script gets the same prefix. The two files Node loads by itself — electron-builder's `afterPack` hook and Oxlint's `jsPlugins` rule — are `.mts` (ESM TypeScript Node strips natively), so they use no CommonJS globals.
- **Build**: `pnpm build:mac` · `build:win` · `build:linux` · `build:android` · `build:cli:all`. Each has a `:lite` twin (`build:mac:lite`, `build:cli:mac:lite`, `build:android:lite`, …) that leaves the local vision model and its runtime out — see `docs/architecture.md` §4a.
- **CLI build prereq**: needs `tar` and network access on first build (the pinned SigLIP model is fetched into `.cache/vision-model` by `scripts/fetch-vision-model.ts`), plus, on macOS, `codesign` (Xcode CLT). The binary is deliberately NOT stripped: the embedded vision runtime's native addons (onnxruntime-node, sharp) need Node's exported N-API symbols. Each CLI target is built on its native-arch runner — mac on `macos-26`, linux x64 on `ubuntu-latest`, linux arm64 on `ubuntu-24.04-arm` (separate `build-cli-arm` job). Local cross-arch builds (e.g. `build:cli:linux-arm` from an x64 host) aren't supported by the script — run on matching hardware or let CI handle it. UPX is intentionally NOT used — macOS AMFI rejects packed Mach-O, and postject's ELF section injection trips UPX's `bad e_phoff` structural check on Linux. Mac CLI binary is ad-hoc signed by the build — no Developer ID / notarization, so browser-downloaded copies still hit Gatekeeper and need `xattr -d com.apple.quarantine`.
- **Settings (dev)**: `pnpm settings:get` · `settings:set <key> <value>` · `settings:schema` · `settings:reset`
- **Tests**: `pnpm test` (full suite) · `pnpm test:watch` · `pnpm test:coverage` — Jest has two projects (`node` and `happy-dom`); React tests are `.test.tsx` under `tests/react/`, everything else is `.test.ts`
- **Lint/format/types**: `pnpm lint` (Oxlint over `src/`, `scripts/`, `tests/`) · `lint:fix` · `format` (Prettier) · `typecheck` (`tsc --noEmit` over the app and `tests/` programs, checker-only — see **Dependencies & Type Checking**)
- **Code hygiene**: `pnpm knip` (unused files/deps/types — config in `knip.json`; the `exports`/`nsExports` rules are off: what they still flag are test hooks — exports only tests read, through a `require()`d module object knip can't trace) · `pnpm size` (renderer bundle brotli **delta** gate — `scripts/check-size-delta.ts` compares each bundle's brotli size against committed `.size-baseline.json` and fails only when one grows more than a threshold (default 5 kB, override `SIZE_DELTA_KB`) since the baseline; it catches an accidental heavy import — e.g. something newly reachable from `App.tsx` pulling in `settings/schema.ts`, whose zod import adds ~60 kB brotlied that tree-shaking does not remove, which is why size-relevant bounds live in the dependency-free `settings/limits.ts` — while letting a few kB of real feature growth through. On intentional growth run `pnpm size:update` and commit the refreshed baseline) · `pnpm size:cli` (coarse SEA binary / `cli-bundled.js` size guard, `scripts/check-cli-size.ts`)
- **README version sync**: `pnpm verify:readme` ensures README version strings match `package.json`. `pnpm update:readme` rewrites them. The release workflow enforces this — drift will fail CI.
- **Semantic lexicon**: `pnpm fetch:embeddings` (manual, network — downloads the pinned GloVe archive once into gitignored `scripts/.cache/`, then prunes/quantizes it into the committed `scripts/lexicon-embeddings.json`; MUST be re-run after editing `scripts/lexicon-concepts.json`, offline once cached) · `pnpm build:lexicon` (offline, deterministic — intermediate → `src/assets/semantic-vectors.json`; CI diffs the output) · `pnpm verify:lexicon` (statistical gate for `SEMANTIC_MATCH_FLOOR`)
- **Web shell**: `pnpm web` builds the CSS and renderer, then serves the UI on localhost (`--port=<n>`). It prints a launch URL ending in `#t=<per-run token>`; every `/api/` request must carry that token.
- **Third-party notices**: `pnpm build:notices` regenerates `src/assets/THIRD_PARTY_NOTICES.txt` from `pnpm-lock.yaml` and the vendored license texts; CI checks it is current, so run it after any dependency change.
- **Android dependency verification**: `scripts/android-verification-metadata.sh` regenerates `android/gradle/verification-metadata.xml` (the SHA-256 of every artifact Gradle resolves; needs JDK 21 or newer (CI builds on 27), the Android SDK and Docker). Run it after any change to the Android dependency graph, including a Dependabot `@capacitor/*` bump, and commit the result; CI checks it.

### Dependency and type reference

- **Off-`latest` pins are intentional** (registry-verified 2026-08-09): `prettier` is a true pre-release (`4.0.0-alpha`, published under `next`); `electron-builder` follows the **`v26` dist-tag**, which carries 26.15.x patches AHEAD of the stale `latest` tag (upstream stopped moving `latest` at 26.15.3). `electron-updater` sits exactly on `latest`. Do **not** "downgrade" any of these to `latest`, and don't merge a bot PR that does. Everything else stays on the exact latest stable.
- **The `v26`-tag blind spot**: `pnpm outdated`, `npm-check-updates`, and Dependabot all compare against the `latest` dist-tag only — patches (or a future CVE fix) published under `v26` are invisible to the whole update pipeline. Check `npm view electron-builder dist-tags` manually when bumping deps.
- **Automated updates**: Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm + github-actions; majors (incl. `github/codeql-action`) land as individual PRs. It never downgrades and only offers pre-release bumps for deps already on a pre-release, so the pins above are preserved. The manual `pnpm bump` (npm-check-updates) still works for ad-hoc bumps.
- **CVE overrides and ignores**: `pnpm-workspace.yaml` carries an exact-pinned `overrides:` block: uuid (pinned by xcode), postcss-selector-parser (pinned at 6.0.10 by `@tailwindcss/typography`, no fix before 7.1.6; the site CSS builds byte-identical on 7.1.7), argparse (only jest's istanbul chain reaches it, through js-yaml 3, whose library code never loads it), global-agent (the 3.x that `@electron/get` takes pulls in roarr and the unpatched sprintf-js; 4.x is already in the shipped tree via `onnxruntime-node`, whose postinstall bootstraps it on every install, and `@electron/get` bootstraps it when `ELECTRON_GET_USE_PROXY` is set — so when installing or packaging behind a global-agent proxy, note that global-agent 4 treats any `NODE_TLS_REJECT_UNAUTHORIZED` value other than `true`/`t`/`yes`/`y`/`on`/`1` as TLS verification OFF; developers who don't need CUDA can install with `ONNXRUNTIME_NODE_INSTALL=skip`, which skips the Linux x64 CUDA 12 download), `@parcel/watcher` (the Tailwind CLI's exact 2.5.1 pulls in micromatch, so every release below 2.6.0 is replaced by it), and minimatch (jest and electron-builder still pin 9/10 copies inside `GHSA-g3hv-75wg-m249`'s range; the 11.0.4 override keeps a CJS export and moves the 9.x copies from ISC to Blue Oak-1.0.0 — both permissive, dev-only, never in the shipped notices tree). `auditConfig.ignoreGhsas` holds the advisories with no patched release: braces `GHSA-vfj7-8cjw-p6xm` (3.0.3 is the latest): what remains is electronmon > watchboy > micromatch > braces, a dev tool matching only this repo's `package.json` patterns, never any app, network or user input, and `tests/ci-validation.test.ts` fails if braces reaches the production tree (`pnpm why braces --prod`); and deepmerge `GHSA-gcqx-w48m-w2h4` (4.3.1 is the latest): its only dependent is jest-config, which merges this repo's own jest config and presets, so no external input reaches `mergeObject()`, and nothing of it ships. The tree also carries dev-only glob 10/13 copies inside `GHSA-3g3m-2fjr-6pw4`'s range (fixed in 14.0.2), auto-dismissed by Dependabot's reachability analysis — re-check when jest moves past glob 13. Re-checked 2026-11-05; re-check with a full `pnpm audit` after lockfile changes and drop an override or an ignore once upstream moves past the vulnerable range.
- **Build-script approval**: pnpm 12 requires opting each native postinstall script into `allowBuilds:` in `pnpm-workspace.yaml`. Keep that list minimal — every entry is an arbitrary-code-execution opportunity.
- **Type checking** (`pnpm typecheck` → `tsc --noEmit`, TypeScript 7's native compiler): the sources under `src/ts` are `.ts` (`.tsx` for JSX), and `tsc` is a **checker only, never a compiler** (`tsconfig.json` sets `noEmit`): esbuild bundles the sources, swc compiles them for Jest, and `node --import tsx` runs them for the CLI and scripts. One program with bundler resolution and DOM + Node typings covers the core and the `.tsx` renderer; every file is strictly checked, the program has zero errors, and new code ships typed. CI gates on it. `scripts/` is in the program too; `tests/` is its own program (`tests/tsconfig.json`, the same strict settings plus Jest's globals, which stay out of `src/ts`), run by the same `pnpm typecheck`. A test keeps each `require()` where it is, because mocks and globals are set up before the module under test loads, and types it where it is produced: `require('…') as typeof M` (with `import type * as M`), or `jest.mocked(require('…') as typeof M)` for a mocked module. A mock names the function it stands in for — `jest.fn<R, [Args]>()`, `jest.MockedFunction<typeof fn>` — never a bare `jest.Mock` (that is `Mock<any, any>`; `tests/ci-validation.test.ts` rejects it); `tests/jest-matchers.ts` types the asymmetric matchers, which `@types/jest` leaves `any`. A deliberately wrong-typed input or partial fixture goes through `invalid<T>(…)` (`tests/helpers/invalid.ts`), never `as unknown as T`. In `.tsx`, write an unconstrained generic arrow as `<T,>(…) =>` so it is not read as JSX. Shared shapes: the GuruShots API payloads (`Challenge`, `RankingEntry`, `VoteImagesResponse`, …) live in the type-only `src/ts/core/types/gurushots.ts`, and `settings/schema.ts` exports `SettingKey` + `SettingValues` (each setting's value type, read off its zod validator) — pull them in with `import type { Challenge } from '../types/gurushots'` rather than re-declaring a shape. Give React state, refs and contexts their type as a type argument (`useState<X | null>(null)`, `createContext<X | null>(null)`) and a typed `useCallback` handler as `useCallback<H>((…) => …, deps)`, not a cast on the initial value. Prefer precise types: a function declares the type it needs and its callers must pass it — don't widen a parameter to `unknown` to make a loose caller compile. GuruShots responses are typed shapes with optional/nullable fields, never `unknown`; `makePostRequest<T>` is the one place a body becomes one, so an endpoint wrapper never casts. IPC handler parameters carry the type the renderer must send (that is what checks `window.api` calls) and still validate at runtime, because the CLI and a compromised window can send anything. `unknown` is only for values with no fixed type: validators/sanitizers whose job is the check, persisted JSON and user-authored documents before validation, caught errors, and the logger's payload. No `any` anywhere, written or leaked — lint-enforced (see **Linting**). The IPC handler map's `IpcHandler` takes `never[]` (every handler's own parameter list is assignable to it), and `invokeHandler` (`src/ts/core/ipc/invokeHandler.ts`, called by the Electron registration in `shells/electron/registerHandlers.ts` and directly by the CLI, web shell and Capacitor bridge) is the one place renderer arguments are passed to a handler, each of which validates its own at runtime. No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- **Linting** (`pnpm lint` → Oxlint, config in `.oxlintrc.json`): one Rust linter for `src/`, `scripts/` and `tests/`, `.ts`/`.tsx`/`.mts`/`.cts` alike, with its own parser, so the TypeScript version doesn't matter to it. The config mirrors `eslint:recommended` (categories off, rules listed; Oxlint lacks only `no-dupe-args` and `no-octal`, both syntax errors in the strict `src/ts` modules), `no-console` / `no-unused-vars` (`_`-prefixed args and catch bindings allowed), `unicorn/prefer-node-protocol` (Node builtins imported as `node:…`), `no-undef` off everywhere tsc checks (tsc resolves every identifier, type queries included), the React hooks rules and jsx-a11y's recommended set (without `control-has-associated-label`'s `includeRoles`, which Oxlint doesn't support) for `src/ts/react/`, the renderer-boundary and settings-facade `no-restricted-imports`, the `window.api` `no-restricted-properties`, and `layer-boundaries/no-cross-layer-import` (`scripts/lint/layer-boundaries.mts`, an **error** over all of `src/ts`: core, platforms, shells and react may import only the layers the table allows, and the packages of one runtime — `electron*`, `@capacitor/*`, `@capawesome-team/*` — only where that runtime runs; `import type` and `typeof import()` are exempt). Type-aware promise rules (`typescript/no-floating-promises`, `no-misused-promises`, `await-thenable`) run over `src/ts` through `oxlint-tsgolint`, which bundles its own typescript-go and ignores the installed `typescript`. `typescript/no-explicit-any` and the type-aware `no-unsafe-*` rules (argument, assignment, call, member-access, return) run over `src/`, `scripts/` and `tests/`: an untyped value is typed before it is used — a lazy require as `require('m') as typeof import('m')`, parsed JSON as `const x: unknown = JSON.parse(…)` narrowed with `isPlainObject` (`src/ts/core/plainObject.ts`) / `isInteger` (`src/ts/core/numbers.ts`) or a type predicate, and a caught value's message is read with `errorMessage` (`src/ts/core/errorMessage.ts`), never a cast. `src/ts/core/types/globals.ts` narrows `Array.isArray` to `unknown[]` (the standard `any[]` would erase a typed array's element type and leak `any`). `scripts/lint/a11y-local.mts` is a local JS plugin (`jsPlugins`, ESLint rule API) for the one check no built-in rule covers: every `<label>` names or wraps its control, and `scripts/lint/frame-guard.mts` (`frame-guard/no-unfiltered-frame-send`, over all of `src/ts`, with no file exempt; the line-level exemptions are pinned in `tests/ci-validation.test.ts`) keeps frame handles and any send off `webContents` out of the source, since `restrictToLogsChannels` filters only `webContents.send`. `oxlint-disable` / `eslint-disable` comments both work. On `void`: it satisfies `no-floating-promises` without handling anything — pair it with `.catch`/try-catch wherever the rejection matters; bare `void` only for inconsequential fire-and-forget calls. Oxlint enables no formatting rules, so Prettier owns formatting. Dependabot bumps `oxlint` and `oxlint-tsgolint` together (`oxlint-toolchain` group). Supply-chain note: devDependencies are outside the blocking `pnpm audit --prod` gate (a non-blocking full audit step surfaces dev-tree CVEs).
- **Repository analysis**: Ripwire is the supported structural-analysis backend for the shared core, `.tsx`, tests, scripts, and whole-repository queries. Use its MCP tools or the pinned `ripwire` CLI workflow appropriate to the question; use `tsc` for compiler-exact type diagnostics.
- **Pre-commit hooks**: `lefthook` (`lefthook.yml`, installed by the `prepare` script) runs `oxlint --fix` + `prettier --write` on staged files only, and re-stages what it fixes (`stage_fixed`) so the fix lands in the same commit — note this re-stages whole files, not partial `git add -p` hunks. Full tests stay in CI. An `--ignore-scripts` install skips hook setup; run `pnpm exec lefthook install` manually if so.
- **CI security gate**: `pnpm audit --prod --audit-level=high` (shipped deps only) runs in the test workflow; CodeQL (`.github/workflows/codeql.yml`) scans on push/PR and weekly.
- **CI hygiene gates**: the test workflow runs `pnpm size` (renderer bundle budgets) in the main `test` job (`ubuntu-latest`) and `pnpm knip` (dead code / unused deps) in a separate `knip` job on `ubuntu-latest` — knip's oxc parser allocates a ~2 GiB ArrayBuffer that the `ubuntu-slim` runner can't satisfy. `pnpm typecheck` runs in its own `typecheck` job on `ubuntu-latest`, so a type error reads as its own red check. Each CLI build job runs `pnpm size:cli`.
