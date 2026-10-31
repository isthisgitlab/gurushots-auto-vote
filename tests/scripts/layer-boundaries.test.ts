/**
 * scripts/lint/layer-boundaries.mts — the Oxlint JS plugin rule that reports an import crossing a layer boundary.
 * Each snippet is parsed into an ESTree (Prettier's TypeScript parser) and the rule's visitors run over it
 * in-process, against the filename the case assigns; one more test hands the same snippets to the real Oxlint, so
 * the AST shapes the rule assumes are the ones Oxlint produces.
 */
import type layerBoundariesPlugin from '../../scripts/lint/layer-boundaries.mts';
import { isPlainObject } from '../../src/ts/plainObject';
import { invalid } from '../helpers/invalid';

const plugin: typeof layerBoundariesPlugin = (
    require('../../scripts/lint/layer-boundaries') as { default: typeof layerBoundariesPlugin }
).default;
const typescript = require('prettier/plugins/typescript') as typeof import('prettier/plugins/typescript');
const rule = plugin.rules['no-cross-layer-import'];

type Visitors = ReturnType<typeof rule.create>;
type Node = Parameters<Visitors['ImportDeclaration']>[0];
interface Report {
    message: string;
    line: number;
}

const parse = (code: string): unknown => typescript.parsers.typescript.parse(code, invalid({}));

// Every node of the tree, in document order, under the visitor that matches its type. Each node gets a `parent`
// link, as the AST Oxlint hands the rule has.
const walk = (
    value: unknown,
    visitors: Readonly<Record<string, ((node: Node) => void) | undefined>>,
    parent?: unknown,
): void => {
    if (Array.isArray(value)) {
        for (const child of value) walk(child, visitors, parent);
        return;
    }
    if (!isPlainObject(value)) return;
    const isNode = typeof value.type === 'string';
    if (isNode) {
        Object.defineProperty(value, 'parent', { value: parent, enumerable: false });
        visitors[value.type as string]?.(invalid<Node>(value));
    }
    for (const [key, child] of Object.entries(value)) {
        if (key !== 'loc' && key !== 'range') walk(child, visitors, isNode ? value : parent);
    }
};

const reportsFor = (code: string, filename: string): Report[] => {
    const reports: Report[] = [];
    const context = {
        filename,
        report: ({ node, message }: { node: Node; message: string }) => {
            reports.push({ message, line: invalid<{ loc: { start: { line: number } } }>(node).loc.start.line });
        },
    };
    walk(parse(code), rule.create(context));
    return reports;
};

// Each distinct message, once, sorted: the same text can be reached through more than one import form.
const messagesFor = (code: string, filename: string): string[] =>
    [...new Set(reportsFor(code, filename).map(({ message }) => message))].sort();

// An absolute filename in a fake checkout, and the one message a crossing reports.
const file = (path: string): string => `/repo/${path}`;
const crossing = (from: string, to: string, specifier: string): string =>
    `layer-boundaries: ${from} → ${to} (${specifier})`;
// A file with no table row of its own: plain core.
const CORE = file('src/ts/services/votingOrchestrator.ts');

// Each import that stays inside the boundaries, with the file that imports it.
const VALID: ReadonlyArray<readonly [string, string]> = [
    // core reaches core, and every package that is not a forbidden one — the package `react` included.
    ["import './votingOrchestrator';", file('src/ts/services/real/pass.ts')],
    ["import './plainObject';", CORE],
    ["import 'zod';", CORE],
    ["import 'react';", CORE],
    // The same through the side-effect, require, import() and both export forms.
    ["import './logger';", CORE],
    ["const store = require('./metadata');", CORE],
    ["const m = import('./metadata');", CORE],
    ["export * from './logger';", CORE],
    ["export { open } from './windowsBridge';", CORE],
    // platform:<x> reaches core, its own platform, and every package — a forbidden one included.
    ["import '../services/votingOrchestrator';", file('src/ts/appPaths.ts')],
    ["import './settings/settingsFileNode';", file('src/ts/appPaths.ts')],
    ["import './settingsFileCapacitor';", file('src/ts/settings/capacitorPreferences.ts')],
    ["import 'electron';", file('src/ts/appPaths.ts')],
    ["import '@capacitor/preferences';", file('src/ts/settings/settingsFileCapacitor.ts')],
    // shell:<x> reaches core, any platform, react, itself, and every package.
    ["import '../services/votingOrchestrator';", file('src/ts/windows/quitGuard.ts')],
    ["import '../appPaths';", file('src/ts/windows/quitGuard.ts')],
    ["import '../react/api/ipc';", file('src/ts/windows/quitGuard.ts')],
    ["import './lifecycle';", file('src/ts/windows/quitGuard.ts')],
    ["import 'electron';", file('src/ts/index.ts')],
    ["import '../services/votingOrchestrator';", file('src/ts/scheduling/runScheduler.ts')],
    ["import '../react/api/ipc';", file('src/ts/bridge/web.ts')],
    ["import '../settings/capacitorPreferences';", file('src/ts/web/server.ts')],
    ["import '../react/pages/Web';", file('src/ts/bridge/web.ts')],
    ["import './plainObject';", file('src/ts/localStores.ts')],
    ["import '../logger';", file('src/ts/headless/index.ts')],
    // react reaches itself and core.
    ["import './api/ipc';", file('src/ts/react/App.tsx')],
    ["import '../plainObject';", file('src/ts/react/App.tsx')],
    ["import './pages/Gallery';", file('src/ts/react/App.tsx')],
    // The pattern rows, through directories that do not exist on disk.
    ["import '../../services/votingOrchestrator';", file('src/ts/platforms/node/store.ts')],
    ["import '../../react/api/ipc';", file('src/ts/shells/web/main.ts')],
    // The core row of the table.
    ["import './store';", file('src/ts/core/store.ts')],
    // A type-only import is skipped only when the build erases it whole — the declaration-level forms, even to a
    // forbidden target. `typeof import()` is never a module edge.
    ["import type { app } from 'electron';", CORE],
    ["export type { app } from 'electron';", CORE],
    ["export type * from 'electron';", CORE],
    ["type T = typeof import('electron');", CORE],
    // The renderer alias `@/` (tsconfig maps it to `src/ts/react/*`): react reaching itself.
    ["import '@/hooks/x';", file('src/ts/react/App.tsx')],
    // `src/ts/platform/` (singular) has no row: the core port is plain core.
    ["import '../plainObject';", file('src/ts/platform/kind.ts')],
    // A file outside src/ts is nobody's layer and not checked.
    ["import 'electron';", file('scripts/build-main.ts')],
    ["import '../src/ts/windows/quitGuard';", file('scripts/build-main.ts')],
    // A path with `src/ts` but no `src/ts/` has no layer either.
    ["import 'electron';", file('src/tsx/odd.ts')],
    // A relative specifier that resolves outside src/ts imports a shared asset, not an app file.
    ["import '../../assets/foo.json';", CORE],
    // Not module edges: no source, a non-literal or non-string argument, wrong arity, a member `require`.
    ['export const value = 1;', CORE],
    ['require(name);', CORE],
    ['require(0);', CORE],
    ['require();', CORE],
    ["require('a', 'b');", CORE],
    ['import(name).then(use);', CORE],
    ["other.require('electron');", CORE],
    // A `\`-separated filename is normalized before the cut.
    ["import './lifecycle';", 'C:\\repo\\src\\ts\\windows\\quitGuard.ts'],
    // `..` and `./` collapse onto the directory row of the layer itself.
    ["import '../..';", file('src/ts/react/pages/a.tsx')],
    ["import './';", file('src/ts/react/App.tsx')],
];

// Each crossing, with the file that imports and the one message the rule reports for it.
const INVALID: ReadonlyArray<readonly [string, string, ...string[]]> = [
    // The case the layering plan pins: a core file reaching a shell module.
    [
        "import '../../windows/quitGuard';",
        file('src/ts/ipc/actions/account.ts'),
        crossing('core', 'shell:electron', '../../windows/quitGuard'),
    ],
    // core reaches nothing but core.
    ["import '../react/api/ipc';", CORE, crossing('core', 'react', '../react/api/ipc')],
    ["import '../appPaths';", CORE, crossing('core', 'platform:node', '../appPaths')],
    [
        "import '../settings/capacitorPreferences';",
        CORE,
        crossing('core', 'platform:webview', '../settings/capacitorPreferences'),
    ],
    ["import '../cli/cli';", CORE, crossing('core', 'shell:cli', '../cli/cli')],
    ["import '../bridge/web';", CORE, crossing('core', 'shell:web', '../bridge/web')],
    ["import '../localStores';", CORE, crossing('core', 'shell:capacitor', '../localStores')],
    ["import '../headless/index';", CORE, crossing('core', 'shell:headless', '../headless/index')],
    // A forbidden package is a crossing on its own, in every import form — the side-effect form included.
    ["import 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    ["import 'electron-log';", CORE, crossing('core', 'forbidden-package', 'electron-log')],
    ["import '@capacitor/app';", CORE, crossing('core', 'forbidden-package', '@capacitor/app')],
    [
        "import '@capawesome-team/capacitor-background-task';",
        CORE,
        crossing('core', 'forbidden-package', '@capawesome-team/capacitor-background-task'),
    ],
    ["const c = require('electron');", CORE, crossing('core', 'forbidden-package', 'electron')],
    ["const m = import('electron');", CORE, crossing('core', 'forbidden-package', 'electron')],
    ["export * from 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    ["export { editor } from 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    // One value specifier among type-only ones is a runtime edge.
    ["import { type app, BrowserWindow } from 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    // Inline `type` specifiers are not erased: with verbatimModuleSyntax the statement stays, a runtime edge.
    [
        "import { type app, type BrowserWindow } from 'electron';",
        CORE,
        crossing('core', 'forbidden-package', 'electron'),
    ],
    ["export { type app } from 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    // The renderer alias `@/` resolves into `src/ts/react/`: react never reaches a shell.
    ["import '@/pages/Web';", file('src/ts/react/PhotoCard.tsx'), crossing('react', 'shell:web', '@/pages/Web')],
    // A checkout under a parent path that itself contains `src/ts/` cuts at the repository's own `src/ts/`.
    [
        "import '../react/api/ipc';",
        '/home/u/src/ts/checkout/src/ts/services/x.ts',
        crossing('core', 'react', '../react/api/ipc'),
    ],
    // A file directly inside a pattern directory has no platform of its own: the captured segment is the empty one.
    [
        "import './node/store';",
        file('src/ts/platforms/index.ts'),
        crossing('platform:', 'platform:node', './node/store'),
    ],
    // platform:<x> reaches core and itself only.
    [
        "import './settings/settingsFileCapacitor';",
        file('src/ts/appPaths.ts'),
        crossing('platform:node', 'platform:webview', './settings/settingsFileCapacitor'),
    ],
    ["import './react/api/ipc';", file('src/ts/appPaths.ts'), crossing('platform:node', 'react', './react/api/ipc')],
    // …and never a shell: the settings file a platform owns cannot reach a shell module.
    [
        "import '../services/NativeAutovoteBridge';",
        file('src/ts/settings/capacitorPreferences.ts'),
        crossing('platform:webview', 'shell:capacitor', '../services/NativeAutovoteBridge'),
    ],
    // The platforms/<x>/ row takes the segment after the prefix.
    [
        "import '../other/store';",
        file('src/ts/platforms/node/store.ts'),
        crossing('platform:node', 'platform:other', '../other/store'),
    ],
    // `../..` onto the pattern row's directory itself: the captured segment is the empty one.
    ["import '../..';", file('src/ts/platforms/node/sub/store.ts'), crossing('platform:node', 'platform:', '../..')],
    // shell:<x> never reaches a sibling shell or a forbidden package.
    [
        "import '../bridge/web';",
        file('src/ts/windows/quitGuard.ts'),
        crossing('shell:electron', 'shell:web', '../bridge/web'),
    ],
    ["import './capacitor';", file('src/ts/bridge/web.ts'), crossing('shell:web', 'shell:capacitor', './capacitor')],
    [
        "import './headless/index';",
        file('src/ts/localStores.ts'),
        crossing('shell:capacitor', 'shell:headless', './headless/index'),
    ],
    [
        "import '../windows/quitGuard';",
        file('src/ts/headless/index.ts'),
        crossing('shell:headless', 'shell:electron', '../windows/quitGuard'),
    ],
    [
        "import '../windows/quitGuard';",
        file('src/ts/scheduling/runScheduler.ts'),
        crossing('shell:cli', 'shell:electron', '../windows/quitGuard'),
    ],
    // The shells/<x>/ row: a sibling shell through a directory that does not exist on disk.
    ["import '../cli/main';", file('src/ts/shells/web/other.ts'), crossing('shell:web', 'shell:cli', '../cli/main')],
    // react reaches nothing but itself and core.
    ["import '../appPaths';", file('src/ts/react/App.tsx'), crossing('react', 'platform:node', '../appPaths')],
    [
        "import '@capacitor/preferences';",
        file('src/ts/react/App.tsx'),
        crossing('react', 'forbidden-package', '@capacitor/preferences'),
    ],
    // First match wins: the Web.tsx row is shell:web, not the react directory row under it.
    ["import './pages/Web';", file('src/ts/react/PhotoCard.tsx'), crossing('react', 'shell:web', './pages/Web')],
    // An extensionless specifier matches the `.tsx` file row as well as the `.ts` row (quitGuard above).
    [
        "import './pages/Capacitor';",
        file('src/ts/react/PhotoCard.tsx'),
        crossing('react', 'shell:capacitor', './pages/Capacitor'),
    ],
    [
        "import './pages/Capacitor.tsx';",
        file('src/ts/react/PhotoCard.tsx'),
        crossing('react', 'shell:capacitor', './pages/Capacitor.tsx'),
    ],
    // The directory boundary keeps `src/ts/cliX/` out of `src/ts/cli/`: it is plain core.
    ["import '../appPaths';", file('src/ts/cliX/a.ts'), crossing('core', 'platform:node', '../appPaths')],
];

test('is registered under its plugin name', () => {
    expect(plugin.meta.name).toBe('layer-boundaries');
    expect(rule.meta.type).toBe('problem');
});

test.each(VALID)('passes: %s', (code, filename) => {
    expect(messagesFor(code, filename)).toEqual([]);
});

test.each(INVALID)('reports: %s', (code, filename, ...messages) => {
    expect(messagesFor(code, filename)).toEqual([...messages].sort());
});

test('a report sits on the line of its specifier', () => {
    expect(reportsFor("import 'zod';\nimport 'electron';", CORE)).toEqual([
        { message: crossing('core', 'forbidden-package', 'electron'), line: 2 },
    ]);
});

test('each crossing reports once, in document order', () => {
    const code = [
        "import './plainObject';",
        "import 'electron';",
        "import '../appPaths';",
        "import '../react/api/ipc';",
    ].join('\n');
    expect(reportsFor(code, CORE).map(({ message }) => message)).toEqual([
        crossing('core', 'forbidden-package', 'electron'),
        crossing('core', 'platform:node', '../appPaths'),
        crossing('core', 'react', '../react/api/ipc'),
    ]);
});

// The real Oxlint, on the same snippets: it must read the AST it gives the rule the way the in-process walk does.
describe('under Oxlint', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const os = jest.requireActual<typeof import('node:os')>('node:os');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const { spawnSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const root = path.join(__dirname, '..', '..');

    test('reports exactly what the in-process walk reports', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-boundaries-'));
        try {
            // Each case: the file's directory under `src/ts/`, its snippet, the crossings expected in it. The
            // pattern-row directories need not exist anywhere else — the test creates what it lints.
            const cases: Array<readonly [string, string, readonly string[]]> = [
                ['services', "import './votingOrchestrator';", []],
                ['services', "import 'zod';", []],
                // A side-effect import of a forbidden target: zero specifiers, and still a runtime edge.
                ['services', "import 'electron';", [crossing('core', 'forbidden-package', 'electron')]],
                [
                    'ipc/actions',
                    "import '../../windows/quitGuard';",
                    [crossing('core', 'shell:electron', '../../windows/quitGuard')],
                ],
                ['services', "import type { app } from 'electron';", []],
                [
                    'services',
                    "import { type app, type BrowserWindow } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['services', "export type { app } from 'electron';", []],
                [
                    'services',
                    "export { type app } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['services', "type T = typeof import('electron');", []],
                ['services', "export * from 'electron';", [crossing('core', 'forbidden-package', 'electron')]],
                ['services', "export type * from 'electron';", []],
                ['services', "export { editor } from 'electron';", [crossing('core', 'forbidden-package', 'electron')]],
                [
                    'services',
                    "import { type app, BrowserWindow } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['services', "const c = require('electron');", [crossing('core', 'forbidden-package', 'electron')]],
                ['services', "const m = import('electron');", [crossing('core', 'forbidden-package', 'electron')]],
                ['services', "import '../../assets/foo.json';", []],
                ['services', 'require(name);', []],
                ['index', "import './lifecycle';", []],
                ['index', "import '../appPaths';", []],
                ['index', "import '../bridge/web';", [crossing('shell:electron', 'shell:web', '../bridge/web')]],
                ['react', "import '../appPaths';", [crossing('react', 'platform:node', '../appPaths')]],
                ['react/pages', "import './Web';", [crossing('react', 'shell:web', './Web')]],
                [
                    'platforms/node',
                    "import '../../settings/capacitorPreferences';",
                    [crossing('platform:node', 'platform:webview', '../../settings/capacitorPreferences')],
                ],
                ['platforms/node', "import 'electron';", []],
                [
                    'platforms/webview',
                    "import '../../bridge/capacitor';",
                    [crossing('platform:webview', 'shell:capacitor', '../../bridge/capacitor')],
                ],
                [
                    'platforms/node',
                    "import '../other/store';",
                    [crossing('platform:node', 'platform:other', '../other/store')],
                ],
                ['shells/web', "import '../../react/api/ipc';", []],
                ['shells/web', "import '../cli/main';", [crossing('shell:web', 'shell:cli', '../cli/main')]],
                ['react', "import '@/pages/Web';", [crossing('react', 'shell:web', '@/pages/Web')]],
                ['react', "import '@/hooks/x';", []],
                // A parent path that itself contains `src/ts/`: the cut is the repository's own, the last one.
                [
                    'checkout/src/ts/services',
                    "import '../react/api/ipc';",
                    [crossing('core', 'react', '../react/api/ipc')],
                ],
                ['platforms', "import './node/store';", [crossing('platform:', 'platform:node', './node/store')]],
                ['platform', "import '../plainObject';", []],
            ];
            const config = path.join(dir, 'oxlintrc.json');
            fs.writeFileSync(
                config,
                JSON.stringify({
                    jsPlugins: [path.join(root, 'scripts/lint/layer-boundaries.mts')],
                    categories: { correctness: 'off' },
                    rules: { 'layer-boundaries/no-cross-layer-import': 'warn' },
                }),
            );
            const files = cases.map(([dirName], index) => path.join(dir, 'src/ts', dirName, `case-${index}.ts`));
            for (const [index, file] of files.entries()) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, cases[index][1]);
            }
            const result = spawnSync(
                process.execPath,
                [path.join(root, 'node_modules/oxlint/bin/oxlint'), '-c', config, '--format=json', dir],
                { encoding: 'utf8', cwd: dir, timeout: 30_000 },
            );
            let output: unknown;
            try {
                output = JSON.parse(result.stdout);
            } catch {
                throw new Error(
                    `oxlint printed no JSON: status ${result.status}, signal ${result.signal}, stderr: ${result.stderr}`,
                );
            }
            const found = new Map<string, Set<string>>();
            const diagnostics = isPlainObject(output) && Array.isArray(output.diagnostics) ? output.diagnostics : [];
            for (const diagnostic of diagnostics) {
                const { filename, message } = invalid<{ filename: string; message: string }>(diagnostic);
                const name = path.relative(dir, filename);
                found.set(name, (found.get(name) ?? new Set<string>()).add(message));
            }
            cases.forEach(([, code, messages], index) => {
                const name = path.relative(dir, files[index]);
                // The in-process walk and the real Oxlint each match the expected crossings, case for case.
                expect([...new Set(reportsFor(code, files[index]).map(({ message }) => message))].sort()).toEqual(
                    [...messages].sort(),
                );
                expect([...(found.get(name) ?? [])].sort()).toEqual([...messages].sort());
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
