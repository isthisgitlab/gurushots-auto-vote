/**
 * scripts/lint/layer-boundaries.mts — the Oxlint JS plugin rule that reports an import crossing a layer boundary.
 * Each snippet is parsed into an ESTree (Prettier's TypeScript parser) and the rule's visitors run over it
 * in-process, against the filename the case assigns; one more test hands the same snippets to the real Oxlint, so
 * the AST shapes the rule assumes are the ones Oxlint produces.
 */
import type layerBoundariesPlugin from '../../scripts/lint/layer-boundaries.mts';
import { isPlainObject } from '../../src/ts/core/plainObject';
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
// A file under the core/ row.
const CORE = file('src/ts/core/services/votingOrchestrator.ts');

// Each import that stays inside the boundaries, with the file that imports it.
const VALID: ReadonlyArray<readonly [string, string]> = [
    // core reaches core, and every package that is not a forbidden one — the package `react` included.
    ["import './votingOrchestrator';", file('src/ts/core/services/real/pass.ts')],
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
    ["import './core/services/votingOrchestrator';", file('src/ts/appPaths.ts')],
    ["import './atomicWrite';", file('src/ts/platforms/node/store.ts')],
    ["import './capacitorPreferences';", file('src/ts/platforms/webview/store.ts')],
    ["import 'electron';", file('src/ts/appPaths.ts')],
    ["import '@capacitor/preferences';", file('src/ts/platforms/webview/capacitorPreferences.ts')],
    // shell:<x> reaches core, any platform, react, itself, and every package.
    ["import '../../../core/services/votingOrchestrator';", file('src/ts/shells/electron/windows/quitGuard.ts')],
    ["import '../../../appPaths';", file('src/ts/shells/electron/windows/quitGuard.ts')],
    ["import '../../../react/api/ipc';", file('src/ts/shells/electron/windows/quitGuard.ts')],
    ["import './lifecycle';", file('src/ts/shells/electron/windows/quitGuard.ts')],
    ["import 'electron';", file('src/ts/shells/electron/index.ts')],
    ["import 'electron/main';", file('src/ts/shells/electron/index.ts')],
    ["import '../../core/services/votingOrchestrator';", file('src/ts/shells/cli/runScheduler.ts')],
    ["import '../../../react/api/ipc';", file('src/ts/shells/web/bridge/web.ts')],
    ["import '../../platforms/webview/capacitorPreferences';", file('src/ts/shells/web/server.ts')],
    ["import '../page';", file('src/ts/shells/web/bridge/web.ts')],
    ["import '../../core/plainObject';", file('src/ts/shells/capacitor/localStores.ts')],
    ["import '../../core/logger';", file('src/ts/shells/headless/index.ts')],
    // The Capacitor background host sits in the Capacitor shell: it reaches the
    // bridges (its own shell) and core (the controller's host type).
    ["import './capacitorBackgroundHost';", file('src/ts/shells/capacitor/bridge/capacitor.ts')],
    ["import '../../../core/autovote/controller';", file('src/ts/shells/capacitor/bridge/capacitorBackgroundHost.ts')],
    // react reaches itself and core.
    ["import './api/ipc';", file('src/ts/react/App.tsx')],
    ["import '../core/plainObject';", file('src/ts/react/App.tsx')],
    ["import './pages/Gallery';", file('src/ts/react/App.tsx')],
    // The pattern rows, through directories that do not exist on disk.
    ["import '../../core/services/votingOrchestrator';", file('src/ts/platforms/node/store.ts')],
    ["import '../../react/api/ipc';", file('src/ts/shells/web/main.ts')],
    // An extensionless directory index: `src/ts/platforms/node` is `platform:node`, the same layer.
    ["import '.';", file('src/ts/platforms/node/store.ts')],
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
    // `src/ts/core/platform/` is the core port: plain core.
    ["import '../plainObject';", file('src/ts/core/platform/kind.ts')],
    // A file under src/ts that no row names is plain core.
    ["import 'zod';", file('src/ts/stray.ts')],
    // A file outside src/ts is nobody's layer and not checked.
    ["import 'electron';", file('scripts/build-main.ts')],
    ["import '../src/ts/shells/electron/windows/quitGuard';", file('scripts/build-main.ts')],
    // A path with `src/ts` but no `src/ts/` has no layer either.
    ["import 'electron';", file('src/tsx/odd.ts')],
    // A relative specifier that resolves outside src/ts imports a shared asset, not an app file.
    ["import '../../../assets/foo.json';", CORE],
    // Not module edges: no source, a non-literal or non-string argument, wrong arity, a member `require`.
    ['export const value = 1;', CORE],
    ['require(name);', CORE],
    ['require(0);', CORE],
    ['require();', CORE],
    ["require('a', 'b');", CORE],
    ['import(name).then(use);', CORE],
    ["other.require('electron');", CORE],
    // A `\`-separated filename is normalized before the cut.
    ["import './lifecycle';", 'C:\\repo\\src\\ts\\shells\\electron\\windows\\quitGuard.ts'],
    // `..` and `./` collapse onto the directory row of the layer itself.
    ["import '../..';", file('src/ts/react/pages/a.tsx')],
    ["import './';", file('src/ts/react/App.tsx')],
];

// Each crossing, with the file that imports and the one message the rule reports for it.
const INVALID: ReadonlyArray<readonly [string, string, ...string[]]> = [
    // The case the layering plan pins: a core file reaching a shell module.
    [
        "import '../../../shells/electron/windows/quitGuard';",
        file('src/ts/core/ipc/actions/account.ts'),
        crossing('core', 'shell:electron', '../../../shells/electron/windows/quitGuard'),
    ],
    // core reaches nothing but core.
    ["import '../../react/api/ipc';", CORE, crossing('core', 'react', '../../react/api/ipc')],
    // The renderer alias `@/` maps to react: a core file taking it crosses into react all the same.
    ["import '@/api/ipc';", CORE, crossing('core', 'react', '@/api/ipc')],
    ["import '../../appPaths';", CORE, crossing('core', 'platform:node', '../../appPaths')],
    [
        "import '../../platforms/webview/store';",
        CORE,
        crossing('core', 'platform:webview', '../../platforms/webview/store'),
    ],
    ["import '../../shells/cli/cli';", CORE, crossing('core', 'shell:cli', '../../shells/cli/cli')],
    ["import '../../shells/web/bridge/web';", CORE, crossing('core', 'shell:web', '../../shells/web/bridge/web')],
    [
        "import '../../shells/capacitor/localStores';",
        CORE,
        crossing('core', 'shell:capacitor', '../../shells/capacitor/localStores'),
    ],
    ["import '../../shells/headless/index';", CORE, crossing('core', 'shell:headless', '../../shells/headless/index')],
    // A forbidden package is a crossing on its own, in every import form — the side-effect form included.
    ["import 'electron';", CORE, crossing('core', 'forbidden-package', 'electron')],
    ["import 'electron-log';", CORE, crossing('core', 'forbidden-package', 'electron-log')],
    ["import 'electron/main';", CORE, crossing('core', 'forbidden-package', 'electron/main')],
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
    // react never reaches a shell, the pages of the web and Capacitor shells included.
    [
        "import '../shells/web/page';",
        file('src/ts/react/PhotoCard.tsx'),
        crossing('react', 'shell:web', '../shells/web/page'),
    ],
    // A checkout under a parent path that itself contains `src/ts/` cuts at the repository's own `src/ts/`.
    [
        "import '../../react/api/ipc';",
        '/home/u/src/ts/checkout/src/ts/core/services/x.ts',
        crossing('core', 'react', '../../react/api/ipc'),
    ],
    // A file directly inside a pattern directory has no platform of its own: the captured segment is the empty one.
    [
        "import './node/store';",
        file('src/ts/platforms/index.ts'),
        crossing('platform:', 'platform:node', './node/store'),
    ],
    // platform:<x> reaches core and itself only.
    [
        "import '../webview/store';",
        file('src/ts/platforms/node/store.ts'),
        crossing('platform:node', 'platform:webview', '../webview/store'),
    ],
    ["import './react/api/ipc';", file('src/ts/appPaths.ts'), crossing('platform:node', 'react', './react/api/ipc')],
    // …and never a shell: the settings file a platform owns cannot reach a shell module.
    [
        "import '../../shells/capacitor/NativeAutovoteBridge';",
        file('src/ts/platforms/webview/capacitorPreferences.ts'),
        crossing('platform:webview', 'shell:capacitor', '../../shells/capacitor/NativeAutovoteBridge'),
    ],
    // The platforms/<x>/ row takes the segment after the prefix.
    [
        "import '../other/store';",
        file('src/ts/platforms/node/store.ts'),
        crossing('platform:node', 'platform:other', '../other/store'),
    ],
    // An extensionless sibling directory reads as that directory's platform, so the crossing is reported.
    [
        "import '../other';",
        file('src/ts/platforms/node/store.ts'),
        crossing('platform:node', 'platform:other', '../other'),
    ],
    // `../..` onto the pattern row's directory itself: the captured segment is the empty one.
    ["import '../..';", file('src/ts/platforms/node/sub/store.ts'), crossing('platform:node', 'platform:', '../..')],
    // shell:<x> never reaches a sibling shell or a forbidden package.
    [
        "import '../../web/bridge/web';",
        file('src/ts/shells/electron/windows/quitGuard.ts'),
        crossing('shell:electron', 'shell:web', '../../web/bridge/web'),
    ],
    [
        "import '../../capacitor/bridge/capacitor';",
        file('src/ts/shells/web/bridge/web.ts'),
        crossing('shell:web', 'shell:capacitor', '../../capacitor/bridge/capacitor'),
    ],
    [
        "import '../headless/index';",
        file('src/ts/shells/capacitor/localStores.ts'),
        crossing('shell:capacitor', 'shell:headless', '../headless/index'),
    ],
    [
        "import '../electron/windows/quitGuard';",
        file('src/ts/shells/headless/index.ts'),
        crossing('shell:headless', 'shell:electron', '../electron/windows/quitGuard'),
    ],
    [
        "import '../electron/windows/quitGuard';",
        file('src/ts/shells/cli/runScheduler.ts'),
        crossing('shell:cli', 'shell:electron', '../electron/windows/quitGuard'),
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
    // A page of a shell is that shell's, with or without the extension.
    [
        "import '../shells/capacitor/page';",
        file('src/ts/react/PhotoCard.tsx'),
        crossing('react', 'shell:capacitor', '../shells/capacitor/page'),
    ],
    [
        "import '../shells/capacitor/page.tsx';",
        file('src/ts/react/PhotoCard.tsx'),
        crossing('react', 'shell:capacitor', '../shells/capacitor/page.tsx'),
    ],
    // A directory under src/ts that no row names is plain core.
    ["import '../appPaths';", file('src/ts/cliX/a.ts'), crossing('core', 'platform:node', '../appPaths')],
    // The bridges are shell files: react cannot import the background host.
    [
        "import '../shells/capacitor/bridge/capacitorBackgroundHost';",
        file('src/ts/react/App.tsx'),
        crossing('react', 'shell:capacitor', '../shells/capacitor/bridge/capacitorBackgroundHost'),
    ],
    // A file under src/ts that no row names is plain core, so a stray file cannot reach react.
    ["import './react/api/ipc';", file('src/ts/stray.ts'), crossing('core', 'react', './react/api/ipc')],
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
        "import '../../appPaths';",
        "import '../../react/api/ipc';",
    ].join('\n');
    expect(reportsFor(code, CORE).map(({ message }) => message)).toEqual([
        crossing('core', 'forbidden-package', 'electron'),
        crossing('core', 'platform:node', '../../appPaths'),
        crossing('core', 'react', '../../react/api/ipc'),
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
        // The real path, so Oxlint prints relative filenames here on macOS as it does on CI's Linux.
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'layer-boundaries-')));
        try {
            // Each case: the file's directory under `src/ts/`, its snippet, the crossings expected in it. The
            // pattern-row directories need not exist anywhere else — the test creates what it lints.
            const cases: Array<readonly [string, string, readonly string[]]> = [
                ['core/services', "import './votingOrchestrator';", []],
                ['core/services', "import 'zod';", []],
                // A side-effect import of a forbidden target: zero specifiers, and still a runtime edge.
                ['core/services', "import 'electron';", [crossing('core', 'forbidden-package', 'electron')]],
                // A package subpath reads as the same forbidden package.
                ['core/services', "import 'electron/main';", [crossing('core', 'forbidden-package', 'electron/main')]],
                ['shells/electron/index', "import 'electron/main';", []],
                [
                    'core/ipc/actions',
                    "import '../../../shells/electron/windows/quitGuard';",
                    [crossing('core', 'shell:electron', '../../../shells/electron/windows/quitGuard')],
                ],
                ['core/services', "import type { app } from 'electron';", []],
                [
                    'core/services',
                    "import { type app, type BrowserWindow } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['core/services', "export type { app } from 'electron';", []],
                [
                    'core/services',
                    "export { type app } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['core/services', "type T = typeof import('electron');", []],
                ['core/services', "export * from 'electron';", [crossing('core', 'forbidden-package', 'electron')]],
                ['core/services', "export type * from 'electron';", []],
                [
                    'core/services',
                    "export { editor } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                [
                    'core/services',
                    "import { type app, BrowserWindow } from 'electron';",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                [
                    'core/services',
                    "const c = require('electron');",
                    [crossing('core', 'forbidden-package', 'electron')],
                ],
                ['core/services', "const m = import('electron');", [crossing('core', 'forbidden-package', 'electron')]],
                ['core/services', "import '../../../assets/foo.json';", []],
                ['core/services', 'require(name);', []],
                ['shells/electron/index', "import './startup';", []],
                ['shells/electron/index', "import '../../../appPaths';", []],
                [
                    'shells/electron/index',
                    "import '../../web/bridge/web';",
                    [crossing('shell:electron', 'shell:web', '../../web/bridge/web')],
                ],
                ['react', "import '../appPaths';", [crossing('react', 'platform:node', '../appPaths')]],
                [
                    'react/pages',
                    "import '../../shells/web/page';",
                    [crossing('react', 'shell:web', '../../shells/web/page')],
                ],
                [
                    'platforms/node',
                    "import '../webview/store';",
                    [crossing('platform:node', 'platform:webview', '../webview/store')],
                ],
                ['platforms/node', "import 'electron';", []],
                [
                    'platforms/webview',
                    "import '../../shells/capacitor/bridge/capacitor';",
                    [crossing('platform:webview', 'shell:capacitor', '../../shells/capacitor/bridge/capacitor')],
                ],
                [
                    'platforms/node',
                    "import '../other/store';",
                    [crossing('platform:node', 'platform:other', '../other/store')],
                ],
                ['shells/web', "import '../../react/api/ipc';", []],
                ['shells/web', "import '../cli/main';", [crossing('shell:web', 'shell:cli', '../cli/main')]],
                ['react', "import '@/hooks/x';", []],
                // A parent path that itself contains `src/ts/`: the cut is the repository's own, the last one.
                [
                    'checkout/src/ts/core/services',
                    "import '../../react/api/ipc';",
                    [crossing('core', 'react', '../../react/api/ipc')],
                ],
                ['platforms', "import './node/store';", [crossing('platform:', 'platform:node', './node/store')]],
                ['core/platform', "import '../plainObject';", []],
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
                // Oxlint prints a filename relative to its working directory when the linted path lies under it, and
                // absolute when a symlink in the path keeps them apart. `dir` is a real path, so only the relative form
                // reaches here; resolving against `dir` keeps the key right for the absolute one too.
                const name = path.relative(dir, path.resolve(dir, filename));
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
