/**
 * The security rules .oxlintrc.json scopes by path — the logger's console sink, the settings facade, the Node-only
 * notifier, the renderer's bridge, the frame-guard — must still fire in every layer directory they cover and stay
 * quiet where they do not. Each case is one fixture file in a temporary `src/ts/` tree, linted by the real Oxlint
 * with the repository's own printed config, so a move of a directory that leaves a glob behind turns this red.
 */
import { isPlainObject } from '../../src/ts/core/plainObject';
import { invalid } from '../helpers/invalid';

const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
const os = jest.requireActual<typeof import('node:os')>('node:os');
const path = jest.requireActual<typeof import('node:path')>('node:path');
const { spawnSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
const root = path.join(__dirname, '..', '..');

// One directory of every layer: the core (with the settings facade inside it), each platform, each shell, react.
const SOURCE_DIRS = [
    'core/services',
    'core/settings',
    'platforms/node',
    'platforms/webview',
    'platforms/headless',
    'shells/electron',
    'shells/cli',
    'shells/web',
    'shells/capacitor',
    'shells/headless',
    'react/components',
] as const;

const RESTRICTED_IMPORT = 'eslint(no-restricted-imports)';
const RESTRICTED_PROPERTY = 'eslint(no-restricted-properties)';
const FRAME_GUARD = 'frame-guard(no-unfiltered-frame-send)';

// [directory, source, the rule codes expected for it, in any order]
type Case = readonly [string, string, readonly string[]];

const everywhere = (source: string, code: string, except: readonly string[] = []): Case[] =>
    SOURCE_DIRS.map((dir): Case => [dir, source, except.includes(dir) ? [] : [code]]);

const CASES: Case[] = [
    // The logger's unredacted console path is importable from the logger's own directory only.
    ...everywhere("import 'x/core/logger/consoleSink';", RESTRICTED_IMPORT),
    ['core/logger', "import './consoleSink';", []],
    // Settings internals are private to the facade: every layer but the facade's own files is held to it.
    ...everywhere("import 'x/core/settings/jsonStore';", RESTRICTED_IMPORT, ['core/settings']),
    ...everywhere("import 'x/core/settings/schema';", RESTRICTED_IMPORT, SOURCE_DIRS),
    ...everywhere("import 'x/core/settings/schema/groups';", RESTRICTED_IMPORT, ['core/settings']),
    // The Node-only notifier spawns a process: the renderer tree must not import it, whichever way it is spelled.
    ['react/components', "import '../../shells/cli/nodeNotify';", [RESTRICTED_IMPORT]],
    ['react/components', "import '../../shells/cli/nodeNotify.js';", [RESTRICTED_IMPORT]],
    ['react/components', "import 'node:child_process';", [RESTRICTED_IMPORT]],
    ['shells/cli', "import './nodeNotify';", []],
    ['core/services', "import '../../shells/cli/nodeNotify';", []],
    // The renderer reaches the shell bridge only through react/api/.
    ['react/components', 'window.api.getSettings();', [RESTRICTED_PROPERTY]],
    ['react/components', 'globalThis.api.getSettings();', [RESTRICTED_PROPERTY]],
    ['react/components', 'window.Capacitor.isNativePlatform();', [RESTRICTED_PROPERTY]],
    ['react/components', 'globalThis.Capacitor.isNativePlatform();', [RESTRICTED_PROPERTY]],
    ['react/api', 'window.api.getSettings();', []],
    ['react/api', 'globalThis.Capacitor.isNativePlatform();', []],
    ['shells/web/bridge', 'window.api = {};', []],
    ['shells/capacitor/bridge', 'globalThis.Capacitor.isNativePlatform();', []],
    // A frame handle is read nowhere in the source without a line-level, reasoned exemption.
    ...everywhere('const frame = event.senderFrame;', FRAME_GUARD),
];

describe('the path-scoped Oxlint rules', () => {
    test('each fires in every layer directory it covers and stays quiet elsewhere', () => {
        // The real path: Oxlint matches an override's globs against the real location of the config.
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oxlint-scoped-')));
        try {
            // The repository's own config, its JS plugins pointed at the real files and its type-aware promise
            // rules left out (the fixtures have no program to check).
            const configText = fs
                .readFileSync(path.join(root, '.oxlintrc.json'), 'utf8')
                .replaceAll('"./scripts/lint/', `"${root}/scripts/lint/`)
                .replace('"typeAware": true', '"typeAware": false');
            expect(configText).toContain(`"${root}/scripts/lint/frame-guard.mts"`);
            expect(configText).toContain('"typeAware": false');
            fs.writeFileSync(path.join(dir, '.oxlintrc.json'), configText);
            const files = CASES.map(([dirName, source], index) => {
                const file = path.join(dir, 'src/ts', dirName, `case-${index}.ts`);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, source);
                return file;
            });
            const result = spawnSync(
                process.execPath,
                [
                    path.join(root, 'node_modules/oxlint/bin/oxlint'),
                    '-c',
                    path.join(dir, '.oxlintrc.json'),
                    '--format=json',
                    'src',
                ],
                { encoding: 'utf8', cwd: dir, timeout: 60_000 },
            );
            let output: unknown;
            try {
                output = JSON.parse(result.stdout);
            } catch {
                throw new Error(
                    `oxlint printed no JSON: status ${result.status}, signal ${result.signal}, stderr: ${result.stderr}`,
                );
            }
            const found = new Map<string, string[]>();
            const diagnostics = isPlainObject(output) && Array.isArray(output.diagnostics) ? output.diagnostics : [];
            for (const diagnostic of diagnostics) {
                const { filename, code } = invalid<{ filename: string; code: string }>(diagnostic);
                // The a11y and layer rules, and the rules unrelated to scoping, are not this test's business.
                if (![RESTRICTED_IMPORT, RESTRICTED_PROPERTY, FRAME_GUARD].includes(code)) continue;
                const name = path.resolve(dir, filename);
                found.set(name, [...(found.get(name) ?? []), code]);
            }
            const mismatches = CASES.flatMap(([dirName, source, expected], index) => {
                const actual = (found.get(files[index]) ?? []).sort();
                return JSON.stringify(actual) === JSON.stringify([...expected].sort())
                    ? []
                    : [`${dirName}: ${source} → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
            });
            expect(mismatches).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
