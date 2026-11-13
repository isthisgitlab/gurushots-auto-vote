/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */
import { isPlainObject } from '../src/ts/core/plainObject';
import { invalid } from './helpers/invalid';

describe('CI Environment Validation', () => {
    test('Node.js version satisfies the engines requirement (>=26)', () => {
        // Keep in sync with package.json "engines" and .nvmrc — this is the
        // project's own floor, not Jest's broader support matrix.
        const majorVersion = parseInt(process.version.slice(1).split('.')[0], 10);

        expect(majorVersion).toBeGreaterThanOrEqual(26);
    });

    test('all required test dependencies should be available', () => {
        // Test that Jest and related packages can be imported
        expect(() => require('jest') as typeof import('jest')).not.toThrow();
        expect(() => require('@jest/globals') as typeof import('@jest/globals')).not.toThrow();
        expect(() => require('jest-environment-node') as typeof import('jest-environment-node')).not.toThrow();
    });

    test('test environment is node with NODE_ENV=test', () => {
        // Jest sets NODE_ENV=test when nothing else did — assert the actual
        // value (a `|| 'test'` fallback could never fail).
        expect(process.env.NODE_ENV).toBe('test');
        expect(typeof process.versions.node).toBe('string');
    });
});

describe('source language', () => {
    // The codebase is TypeScript end to end; a .js/.jsx/.mjs/.cjs file slips
    // past tsc and the no-`any` lint rules. Tracked and untracked-but-not-ignored
    // files both count, so a new file fails locally before it is ever staged.
    test('the repository contains no JavaScript files', () => {
        const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const root = path.join(__dirname, '..');
        const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: root,
            encoding: 'utf8',
        }).split('\n');
        // The index still lists a file renamed on disk but not yet staged.
        expect(files.filter((f) => /\.[cm]?jsx?$/.test(f) && fs.existsSync(path.join(root, f)))).toEqual([]);
    });
});

describe('shipped dependency tree', () => {
    // braces (GHSA-vfj7-8cjw-p6xm) has no patched release and is excepted in
    // pnpm-workspace.yaml's `auditConfig` because only dev tooling (electronmon's
    // watcher) reaches it. That exception holds only while it stays out of the
    // shipped tree: `pnpm why braces --prod` must find nothing.
    test('braces is not reachable from the production dependencies', () => {
        const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const stdout = execFileSync('pnpm', ['why', 'braces', '--prod', '--json'], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 30_000,
            // pnpm is a .cmd shim on Windows, which execFile cannot start without a shell.
            shell: process.platform === 'win32',
        });
        let found: unknown;
        try {
            found = JSON.parse(stdout);
        } catch {
            throw new Error(`pnpm why did not print JSON: ${stdout}`);
        }
        expect(found).toEqual([]);
    });
});

describe('test typing', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    // `file:line` of every match of the global `pattern` in the test sources.
    const offendersOf = (pattern: RegExp) => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(c?ts|tsx)$/.test(entry.name)) {
                    const text = fs.readFileSync(full, 'utf8');
                    for (const match of text.matchAll(pattern)) {
                        const line = text.slice(0, match.index).split('\n').length;
                        offenders.push(`${path.relative(__dirname, full)}:${line}`);
                    }
                }
            }
        };
        walk(__dirname);
        return offenders;
    };

    // `Mock` without type arguments is `Mock<any, any>`, an `any` the lint rules
    // cannot see until a value is used; a mock names the function it stands in
    // for (`jest.fn<R, [Args]>()`, `jest.MockedFunction<typeof fn>`).
    test('every mock type names the function it stands in for', () => {
        expect(offendersOf(/\bjest\.Mock\b(?!<)/g)).toEqual([]);
    });

    // Parsed JSON is `unknown` until `tests/helpers/parseJson.ts` (or a guard
    // built from it) has checked the fields a test reads; a cast would assert
    // a shape nothing verified.
    test('parsed JSON is narrowed by a guard, never cast', () => {
        expect(offendersOf(/JSON\.parse\((?:[^;()]|\([^()]*\))*\)\s+as\s/g)).toEqual([]);
    });
});

describe('sends toward the Logs window', () => {
    const RULE = 'frame-guard/no-unfiltered-frame-send';
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const typescript = require('prettier/plugins/typescript') as typeof import('prettier/plugins/typescript');
    const root = path.join(__dirname, '..');
    const srcFiles = (): string[] => fs.globSync('src/ts/**/*.{ts,tsx}', { cwd: root });
    // restrictToLogsChannels (shells/electron/registerHandlers.ts) filters only `webContents.send`; the frame-guard Oxlint rule
    // (scripts/lint/frame-guard.mts) keeps every other route to a window out of src/ts. Switching it off, or widening
    // its exemptions, has to show up here.
    test('Oxlint runs the frame-guard rule over all of src/ts with no file exempt', () => {
        const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        const printed: unknown = JSON.parse(
            execFileSync(process.execPath, [path.join(root, 'node_modules/oxlint/bin/oxlint'), '--print-config'], {
                cwd: root,
                encoding: 'utf8',
                timeout: 30_000,
            }),
        );
        const config = isPlainObject(printed) ? printed : {};
        expect(config.jsPlugins).toContain('./scripts/lint/frame-guard.mts');
        expect(fs.existsSync(path.join(root, 'scripts/lint/frame-guard.mts'))).toBe(true);
        const overrides: unknown[] = Array.isArray(config.overrides) ? config.overrides : [];
        const enabling = overrides.filter(
            (override) => isPlainObject(override) && isPlainObject(override.rules) && RULE in override.rules,
        );
        // One override switches the rule on; none later switches it off or narrows its files.
        expect(enabling).toHaveLength(1);
        expect(enabling[0]).toMatchObject({
            files: ['src/ts/**/*.ts', 'src/ts/**/*.tsx'],
            rules: { [RULE]: 'deny' },
        });
        // A file exemption would let a new send through in the file that implements the filter.
        expect(enabling[0]).not.toHaveProperty('excludeFiles');
        // Nothing under src/ts besides the type-only declarations is skipped by Oxlint.
        expect(config.ignorePatterns).toEqual(['src/ts/core/types/**']);
    });

    // A second config would apply to the files under its directory instead of the root one.
    test('the root .oxlintrc.json is the only Oxlint config in the repository', () => {
        const configs = fs.globSync(
            '**/{.oxlintrc.json,.oxlintrc.jsonc,oxlintrc.json,oxlint.config.{ts,mts,cts,js,mjs,cjs}}',
            {
                cwd: root,
                exclude: (entry) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(entry)),
            },
        );
        expect(configs).toEqual(['.oxlintrc.json']);
    });

    // An ignore file at the root would drop files from the lint run.
    test('no .eslintignore exists and the lint script is the pinned command', () => {
        expect(fs.existsSync(path.join(root, '.eslintignore'))).toBe(false);
        const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const scripts = isPlainObject(manifest) && isPlainObject(manifest.scripts) ? manifest.scripts : {};
        expect(scripts.lint).toBe('pnpm run turbo run validate:lint');
        expect(scripts['validate:lint']).toBe('oxlint src scripts tests');
    });

    // Oxlint ignores src/ts/core/types, so nothing there may run: every top-level statement is a type declaration.
    test('src/ts/core/types holds only type declarations', () => {
        const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration']);
        const isTypeOnly = (statement: unknown): boolean => {
            const node = invalid<{
                type: string;
                declare?: boolean;
                exportKind?: string;
                importKind?: string;
                declaration?: unknown;
                specifiers?: unknown[];
                source?: unknown;
            }>(statement);
            if (node.declare === true || TYPE_ONLY.has(node.type)) return true;
            if (node.type === 'ImportDeclaration') return node.importKind === 'type';
            if (node.type !== 'ExportNamedDeclaration') return false;
            if (node.exportKind === 'type') return true;
            if (node.declaration !== undefined && node.declaration !== null) return isTypeOnly(node.declaration);
            return node.specifiers?.length === 0 && node.source == null;
        };
        // The 1-based line of each top-level statement that is not a type declaration.
        const runtimeLines = (code: string): number[] => {
            const ast: unknown = typescript.parsers.typescript.parse(code, invalid({}));
            const body: unknown[] = isPlainObject(ast) && Array.isArray(ast.body) ? ast.body : [];
            return body
                .filter((statement) => !isTypeOnly(statement))
                .map((statement) => invalid<{ loc: { start: { line: number } } }>(statement).loc.start.line);
        };
        expect(
            runtimeLines(
                [
                    "import type { A } from './a';",
                    'export interface B { a: A }',
                    'type C = B;',
                    'export type D = C;',
                    'export type { D as E };',
                    'declare global { interface W { x: number } }',
                    'declare const g: number;',
                    'export declare function f(): void;',
                    'export {};',
                ].join('\n'),
            ),
        ).toEqual([]);
        expect(
            runtimeLines(
                [
                    "import { a } from './a';",
                    'export const x = 1;',
                    'export function f() {}',
                    'const y = 2;',
                    'enum E { A }',
                    'export { y };',
                    "export * from './a';",
                    'f();',
                ].join('\n'),
            ),
        ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        const offenders: string[] = [];
        const files = fs.globSync('src/ts/core/types/**/*.{ts,tsx}', { cwd: root });
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            for (const line of runtimeLines(fs.readFileSync(path.join(root, file), 'utf8'))) {
                offenders.push(`${file}:${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    // The only legitimate frame reads and off-window sends, each a line-level disable with a reason.
    const EXEMPTIONS: ReadonlyArray<readonly [string, string]> = [
        ['src/ts/shells/electron/registerHandlers.ts', 'const frame = event.senderFrame;'],
        [
            'src/ts/shells/electron/registerHandlers.ts',
            'if (event.sender?.mainFrame && frame !== event.sender.mainFrame) return false;',
        ],
        [
            'src/ts/shells/electron/registerHandlers.ts',
            "return event.senderFrame?.url ?? event.sender?.getURL?.() ?? '<unknown>';",
        ],
        ['src/ts/shells/electron/registerHandlers.ts', 'webContents.send = (channel: string, ...args: unknown[]) =>'],
        ['src/ts/shells/electron/preloadApi.ts', 'api[method] = () => ipcRenderer.send(channel);'],
        // The remote pairing transport is a WebRTC data channel, not a frame; every .send on
        // it is a protocol message to the paired peer.
        [
            'src/ts/core/autovote/remote.ts',
            "await deps.transport.send({ t: 'autovote-command', command }, remoteHostPeerId() ?? undefined);",
        ],
        [
            'src/ts/core/remote/trystero.ts',
            'send: (message, target) => action.send(message as JsonValue, target === undefined ? {} : { target }),',
        ],
        ['src/ts/react/api/remoteHostPeers.ts', 'await transport.send(message, peerId);'],
        [
            'src/ts/shells/remote/bridge/invokes.ts',
            'for (const held of heldSends.splice(0)) void transport.send(held.message, to);',
        ],
        // The phone's repeated hello (the loader and the peer bridge share it).
        ['src/ts/core/remote/helloRepeat.ts', 'void transport.send(announce, peerId).catch(() => undefined);'],
        ['src/ts/shells/remote/bridge/invokes.ts', 'void transport.send(message, hostPeerId).catch(() => {'],
        // The relay fallback: its own WebSockets to public Nostr relays, and the hybrid transport's choice of path.
        ['src/ts/core/remote/relaySockets.ts', 'relay.socket.send(options.subscribeFrame(RELAY_SUB_ID, topic));'],
        ['src/ts/core/remote/relaySockets.ts', 'for (const relay of open) relay.socket.send(event);'],
        [
            'src/ts/core/remote/hybridTransport.ts',
            "return (path === 'direct' ? direct : (relay as RemoteTransport)).send(message, target);",
        ],
        // An upgrade sends the messages the relay link handed over, and the late ones, over the WebRTC path the peer has moved to.
        [
            'src/ts/core/remote/hybridTransport.ts',
            "state.direct.send(message, peerId).catch(() => lose(state, peerId, 'direct'));",
        ],
    ];

    interface Directive {
        // 1-based line of the comment's end (the line a `-line` directive sits on, the one before a `-next-line` target).
        line: number;
        // The comment as written in the source.
        raw: string;
        // What follows the directive keyword: the rule list, minus a `-- reason`.
        rules: string;
    }

    // Every oxlint/eslint disable directive in `code`, read from its real comments: a string that holds the words is
    // not one, and a block comment's directive may sit on any of its lines.
    const directivesIn = (code: string): Directive[] => {
        const ast: unknown = typescript.parsers.typescript.parse(code, invalid({}));
        const comments: unknown[] = isPlainObject(ast) && Array.isArray(ast.comments) ? ast.comments : [];
        const found: Directive[] = [];
        for (const comment of comments) {
            const { value, range, loc } = invalid<{
                value: string;
                range: [number, number];
                loc: { end: { line: number } };
            }>(comment);
            const match = /^(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)(.*)$/s.exec(value.trim());
            if (!match) continue;
            found.push({
                line: loc.end.line,
                raw: code.slice(range[0], range[1]),
                rules: match[1].split(/(?:^|\s)--(?:\s|$)/)[0].trim(),
            });
        }
        return found;
    };

    // A directive that names no rule switches off every rule, frame-guard included.
    const bareDisableLines = (code: string): number[] =>
        directivesIn(code)
            .filter(({ rules }) => rules === '')
            .map(({ line }) => line);

    test('a disable directive that names no rule is reported, one that names a rule is not', () => {
        const sample = [
            '// oxlint-disable-next-line',
            '// eslint-disable-line',
            '/* eslint-disable */',
            '// oxlint-disable-next-line -- because',
            '// oxlint-disable-next-line no-control-regex',
            'const a = 1; // eslint-disable-line no-console, no-undef',
            '/* oxlint-disable no-console */',
            '// oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- reason',
            'const text = "oxlint-disable";',
            'const t = `// oxlint-disable`;',
        ].join('\n');
        expect(bareDisableLines(sample)).toEqual([1, 2, 3, 4]);
        expect(bareDisableLines('/*\n oxlint-disable\n*/')).toEqual([3]);
        expect(bareDisableLines('frame.send("c"); /*\noxlint-disable-line */')).toEqual([2]);
        expect(bareDisableLines('// oxlint-disable-nextline')).toEqual([]);
    });

    test('every disable directive in src/ts names the rule it silences', () => {
        const offenders: string[] = [];
        for (const file of srcFiles()) {
            for (const line of bareDisableLines(fs.readFileSync(path.join(root, file), 'utf8'))) {
                offenders.push(`${file}:${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the frame-guard disable comments in src/ts are exactly the pinned set, each with a reason', () => {
        const found: Array<readonly [string, string]> = [];
        for (const file of srcFiles()) {
            const code = fs.readFileSync(path.join(root, file), 'utf8');
            const lines = code.split('\n');
            for (const { raw, rules, line } of directivesIn(code)) {
                // Any directive that lists the rule, or a rule of the same plugin, counts.
                if (!rules.includes('frame-guard')) continue;
                expect(raw).toMatch(/^\/\/ oxlint-disable-next-line frame-guard\/no-unfiltered-frame-send -- \S.*$/);
                found.push([file, lines[line].trim()]);
            }
        }
        expect(found.sort()).toEqual([...EXEMPTIONS].sort());
    });
});

// Every channel an ipcMain call registers must pass the sender-frame check. registerHandlers wraps each handle
// channel in it, so no other file may call ipcMain.handle, and no other registration method (handleOnce, once,
// addListener, prependListener, prependOnceListener) may appear anywhere under src/ts — each would add a channel
// or listener that never passes that check; the two send-style channels the Electron entry registers with
// ipcMain.on carry no reply and apply the same checks by hand, each at its own guarded site.
describe('ipcMain registration', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const root = path.join(__dirname, '..');
    const REGISTER_HANDLERS = 'src/ts/shells/electron/registerHandlers.ts';
    const ENTRY = 'src/ts/shells/electron/index.ts';
    const callsOf = (method: 'handle' | 'on'): Array<readonly [string, string]> =>
        fs
            .globSync('src/ts/**/*.{ts,tsx}', { cwd: root })
            .sort()
            .flatMap((file) =>
                [
                    ...fs
                        .readFileSync(path.join(root, file), 'utf8')
                        .matchAll(new RegExp(`\\bipcMain\\.${method}\\(([^,)]*)`, 'g')),
                ].map((match) => [file, match[1].trim()] as const),
            );

    test('ipcMain.handle is called only in registerHandlers, once', () => {
        expect(callsOf('handle')).toEqual([[REGISTER_HANDLERS, 'channel']]);
    });

    test('ipcMain.on is called only in the Electron entry, at the two guarded sites', () => {
        expect(callsOf('on')).toEqual([
            [ENTRY, "'login-success'"],
            [ENTRY, "'logout'"],
        ]);
        const entry = fs.readFileSync(path.join(root, ENTRY), 'utf8');
        for (const channel of ['login-success', 'logout']) {
            const site = entry.slice(entry.indexOf(`ipcMain.on('${channel}'`));
            const guard = site.slice(0, site.indexOf('});'));
            expect(guard).toContain('isTrustedSender(event)');
            expect(guard).toContain(`isChannelAllowedForSender(event, '${channel}')`);
        }
    });

    test('no other ipcMain registration method appears anywhere in src/ts', () => {
        const FORBIDDEN = ['handleOnce', 'once', 'addListener', 'prependListener', 'prependOnceListener'];
        const offenders = fs
            .globSync('src/ts/**/*.{ts,tsx}', { cwd: root })
            .sort()
            .flatMap((file) =>
                [
                    ...fs
                        .readFileSync(path.join(root, file), 'utf8')
                        .matchAll(new RegExp(`\\bipcMain\\.(?:${FORBIDDEN.join('|')})\\(`, 'g')),
                ].map((match) => `${file}: ${match[0]}`),
            );
        expect(offenders).toEqual([]);
    });
});

// The layer-boundaries Oxlint rule (scripts/lint/layer-boundaries.mts) reports an import crossing a layer
// boundary; the layering is complete, so the rule must stay switched on over all of src/ts and at error — a
// quieter level would let a new crossing through.
describe('layer boundaries', () => {
    const RULE = 'layer-boundaries/no-cross-layer-import';
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const root = path.join(__dirname, '..');
    test('Oxlint runs the layer-boundaries rule over all of src/ts at error, with no file exempt', () => {
        const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        const printed: unknown = JSON.parse(
            execFileSync(process.execPath, [path.join(root, 'node_modules/oxlint/bin/oxlint'), '--print-config'], {
                cwd: root,
                encoding: 'utf8',
                timeout: 30_000,
            }),
        );
        const config = isPlainObject(printed) ? printed : {};
        expect(config.jsPlugins).toContain('./scripts/lint/layer-boundaries.mts');
        expect(fs.existsSync(path.join(root, 'scripts/lint/layer-boundaries.mts'))).toBe(true);
        const overrides: unknown[] = Array.isArray(config.overrides) ? config.overrides : [];
        const enabling = overrides.filter(
            (override) => isPlainObject(override) && isPlainObject(override.rules) && RULE in override.rules,
        );
        // One override switches the rule on; none later switches it off or narrows its files.
        expect(enabling).toHaveLength(1);
        expect(enabling[0]).toMatchObject({
            files: ['src/ts/**/*.ts', 'src/ts/**/*.tsx'],
            rules: { [RULE]: 'deny' }, // Oxlint prints the config's "error" as "deny"
        });
        // A file exemption would let a crossing through unflagged.
        expect(enabling[0]).not.toHaveProperty('excludeFiles');
    });
});

describe('stylesheet sources', () => {
    // Tailwind generates only the classes it finds in its @source files, so a
    // glob that matches nothing (a renamed extension, a moved folder) silently
    // ships a stylesheet without the app's utility classes.
    test('every Tailwind @source glob matches a file', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const root = path.join(__dirname, '..');
        const missing: string[] = [];
        for (const css of ['src/styles/styles.css', 'scripts/site/site.css']) {
            const dir = path.dirname(path.join(root, css));
            for (const [, glob] of fs.readFileSync(path.join(root, css), 'utf8').matchAll(/@source\s+"([^"]+)"/g)) {
                // Build output (dist*/) is generated before its CSS build and absent in a fresh checkout.
                if (/(^|\/)dist[^/]*\//.test(glob)) continue;
                if (fs.globSync(glob, { cwd: dir }).length === 0) missing.push(`${css}: ${glob}`);
            }
        }
        expect(missing).toEqual([]);
    });

    // styles.css compiles `themes: all`; the pickers offer THEMES. A daisyui
    // bump that adds or drops a theme must update the list (and its labels).
    test('THEMES lists exactly the themes the installed daisyui ships', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const { THEMES } = jest.requireActual<typeof import('../src/ts/core/settings/uiDefaults')>(
            '../src/ts/core/settings/uiDefaults',
        );
        const themeDir = path.join(__dirname, '..', 'node_modules', 'daisyui', 'theme');
        const shipped = fs
            .readdirSync(themeDir)
            .filter((f) => f.endsWith('.css'))
            .map((f) => f.slice(0, -'.css'.length));
        expect([...THEMES].sort()).toEqual(shipped.sort());
        expect(fs.readFileSync(path.join(__dirname, '..', 'src/styles/styles.css'), 'utf8')).toMatch(/themes:\s*all;/);
    });
});

describe('renderer button colours', () => {
    // A theme guarantees `X` + `X-content` (a solid button) and `base-content` on `base-*`, nothing else. daisyUI paints
    // `btn-outline`, `btn-soft`, `btn-ghost` and `btn-dash` with the colour variant's raw colour on the page
    // background, which a theme can make unreadable (business: neutral 27% on base-100 24%). Over `src/ts/react`
    // (.ts and .tsx) this enforces: (a) no single string or template literal holds one of those styles together with
    // a colour variant class (a template is checked by its static parts, and each `${…}` body, nested templates
    // included, is scanned as code of its own); (b) no `<ActionButton>` tag has a colour `variant` (a `variant="…"`
    // other than `plain`, or a `variant={…}` expression with a string literal other than `plain`) or an `error`
    // attribute (it swaps in `btn-error` whatever the variant) and a literal holding one of those styles. Comments are
    // ignored, and a quote, `>` or brace inside a string never ends a tag or a `${…}` early. Not seen: a `variant`
    // that is an identifier or lookup, and any literal after two apostrophes in JSX text on one line (they pair up).
    const STYLES = ['btn-outline', 'btn-soft', 'btn-ghost', 'btn-dash'];
    const COLOUR_VARIANT = /^btn-(?:neutral|primary|secondary|accent|info|success|warning|error|latvian)$/;
    // End (exclusive) of the string, template or comment starting at `i`, or `i + 1` when none does. A string never
    // spans a line, so a lone apostrophe in JSX text is not taken for one (two on a line still pair up); a template
    // skips its `${…}` bodies by brace depth.
    const spanAt = (code: string, i: number): number => {
        const c = code[i];
        if (c === "'" || c === '"' || c === '`') {
            for (let j = i + 1; j < code.length; j++) {
                if (code[j] === '\\') j++;
                else if (code[j] === c) return j + 1;
                else if (c === '`' && code[j] === '$' && code[j + 1] === '{') j = closeOf(code, j + 1, true);
                else if (code[j] === '\n' && c !== '`') return i + 1;
            }
            return code.length;
        }
        if (code.startsWith('/*', i))
            return code.indexOf('*/', i + 2) < 0 ? code.length : code.indexOf('*/', i + 2) + 2;
        if (code.startsWith('//', i)) return code.indexOf('\n', i) < 0 ? code.length : code.indexOf('\n', i);
        return i + 1;
    };

    // Index of the `}` closing the `{` at `from` (brace), or of the first `>` outside braces and strings at or after
    // `from`.
    const closeOf = (code: string, from: number, brace: boolean) => {
        let depth = 0;
        for (let i = from; i < code.length; i++) {
            const end = spanAt(code, i);
            if (end - i > 1) {
                i = end - 1;
                continue;
            }
            if (code[i] === '{') depth++;
            else if (code[i] === '}') depth--;
            if (brace ? depth === 0 : depth === 0 && code[i] === '>') return i;
        }
        return code.length;
    };

    // `code` cut into its top-level strings, templates and comments (`literal`) and the single characters between.
    const chunksOf = (code: string) => {
        const chunks: Array<{ text: string; literal: boolean }> = [];
        for (let i = 0; i < code.length; ) {
            const end = spanAt(code, i);
            chunks.push({ text: code.slice(i, end), literal: end - i > 1 });
            i = end;
        }
        return chunks;
    };
    const isComment = ({ text, literal }: { text: string; literal: boolean }) => literal && text.startsWith('/');

    const withoutComments = (code: string) =>
        chunksOf(code)
            .filter((chunk) => !isComment(chunk))
            .map((chunk) => chunk.text)
            .join('');

    const literalsIn = (code: string): string[] =>
        chunksOf(code).flatMap((chunk) => {
            if (!chunk.literal || isComment(chunk)) return [];
            const span = chunk.text;
            if (span[0] !== '`') return [span.slice(1, -1)];
            let statics = '';
            const bodies: string[] = [];
            for (let i = 1; i < span.length - 1; ) {
                if (span[i] === '\\') {
                    statics += span.slice(i, i + 2);
                    i += 2;
                } else if (span.startsWith('${', i)) {
                    const end = closeOf(span, i + 1, true);
                    bodies.push(span.slice(i + 2, end));
                    statics += ' ';
                    i = end + 1;
                } else statics += span[i++];
            }
            return [statics, ...bodies.flatMap(literalsIn)];
        });

    const tokensOf = (literal: string) => literal.split(/\s+/);
    const mixesStyleAndColour = (literal: string) => {
        const tokens = tokensOf(literal);
        return STYLES.some((s) => tokens.includes(s)) && tokens.some((t) => COLOUR_VARIANT.test(t));
    };

    const colourVariantTag = (tag: string) => {
        if (/\serror(?=[\s=>/])/.test(tag)) return true;
        const quoted = /\bvariant="([^"]*)"/.exec(tag);
        if (quoted) return quoted[1] !== 'plain';
        const expr = tag.indexOf('variant={');
        if (expr < 0) return false;
        const start = expr + 'variant='.length;
        return literalsIn(tag.slice(start, closeOf(tag, start, true) + 1)).some((l) => l.trim() !== 'plain');
    };

    /** The literals and `<ActionButton>` tags of `code` that pair an outline-style class with a colour variant. */
    const offendersIn = (source: string) => {
        const code = withoutComments(source);
        const offenders = literalsIn(code).filter(mixesStyleAndColour);
        for (const { index } of code.matchAll(/<ActionButton\b/g)) {
            const tag = code.slice(index, closeOf(code, index, false) + 1);
            const styled = literalsIn(tag).some((l) => STYLES.some((s) => tokensOf(l).includes(s)));
            if (styled && colourVariantTag(tag)) offenders.push(tag);
        }
        return offenders;
    };

    test('the scan flags a colour paired with an outline style, however it is split across the source', () => {
        const flagged = [
            // The #59 shape: the colour comes from the variant prop, the outline from a separate literal.
            `<ActionButton variant="neutral" className={[pressed ? '' : 'btn-outline', busy ? 'btn-disabled' : ''].filter(Boolean).join(' ')}>`,
            '<ActionButton variant={pressed ? KINDS[kind] : \'warning\'} className="btn-soft" onClick={() => go()}>',
            '`btn btn-outline ${x} btn-warning`',
            '"btn-ghost btn-error"',
            "const s = `a ${ok ? 'btn-dash btn-info' : ''}`;",
            // A template nested in a `${…}` body, and a `>` inside a quoted attribute.
            "`a ${x ? `btn-outline btn-error` : ''}`",
            '<ActionButton title="a > b" variant="neutral" className="btn-outline">',
            // `error` swaps in btn-error whatever the variant.
            '<ActionButton variant="plain" error={e} className="btn-outline">',
            '<ActionButton variant="plain" error className="btn-outline">',
            // A brace inside a string in a `${…}` body, and a comment inside a tag.
            "`a ${x ? '}' : 'btn-outline btn-error'}`",
            '<ActionButton /* > */ variant="neutral" className="btn-outline">',
        ];
        for (const source of flagged) expect(offendersIn(source)).not.toEqual([]);
        const passing = [
            "'btn btn-sm btn-outline'",
            '<ActionButton variant="plain" className="btn-outline">',
            "<ActionButton variant={pressed ? PINNED[kind] : 'plain'} className={pressed ? '' : 'btn-outline'}>",
            '<ActionButton variant="neutral" onClick={() => go()}>',
            "// it's a btn-outline btn-error note\nconst a = 'btn btn-outline';",
            "const url = 'https://x.test'; const b = 'btn btn-neutral';",
            '<ActionButton variant="neutral" error={e} onClick={() => go()}>',
            "const c = `btn btn-sm${className ? ` ${className}` : ''}`;",
            '<ActionButton title="a > b" variant="plain" className="btn-outline">',
        ];
        for (const source of passing) expect(offendersIn(source)).toEqual([]);
    });

    test('no renderer source pairs an outline-style class with a colour variant', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const root = path.join(__dirname, '..');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) {
                    for (const found of offendersIn(fs.readFileSync(full, 'utf8'))) {
                        offenders.push(`${path.relative(root, full)}: ${found}`);
                    }
                }
            }
        };
        walk(path.join(root, 'src/ts/react'));
        expect(offenders).toEqual([]);
    });
});

// The layering plan keeps the platform code out of the renderer bundles: the renderer chain lives in
// src/ts/core/autovote/chain.ts (controller.ts composes it) and the native services arrive as an injected background host
// (src/ts/shells/capacitor/bridge/capacitorBackgroundHost.ts) that only the Capacitor page imports. An indirect import could
// route around a source-text scan, so the evidence is esbuild's own module graph: the four renderer bundles
// are rebuilt in-process with the build script's exact options and every input file is checked.
describe('renderer bundle graphs', () => {
    // tests/setup.ts mocks fs and path globally; esbuild's client resolves paths for real.
    jest.unmock('fs');
    jest.unmock('path');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const root = path.join(__dirname, '..');
    // The Electron pages, the web-shell entry and the remote phone page. The Capacitor, headless
    // and preload bundles may legitimately reach the platform code and are not checked.
    const CHECKED_ENTRIES = ['app', 'login', 'logs', 'web', 'remote'] as const;
    const FORBIDDEN_EXACT = [
        'src/ts/core/platform/port.ts',
        'src/ts/shells/capacitor/NativeAutovoteBridge.ts',
        'src/ts/shells/capacitor/ForegroundServiceController.ts',
        'src/ts/shells/capacitor/AndroidUpdateInstaller.ts',
    ];
    const FORBIDDEN_DIR = 'src/ts/platforms/';

    type BuildReact = typeof import('../scripts/build-react');
    type EntryName = keyof BuildReact['entryPoints'];

    // build-react reads process.env.NODE_ENV at module load and bakes its
    // options, so under Jest it would build the NODE_ENV=test graph while a
    // release builds production. Load it in isolation with the release value
    // set, restoring the original in a finally — nothing else may observe the
    // temporary value.
    const loadBuildOptions = (): Pick<BuildReact, 'commonOptions' | 'entryPoints' | 'perEntryOptions'> => {
        const saved = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            let options: Pick<BuildReact, 'commonOptions' | 'entryPoints' | 'perEntryOptions'>;
            jest.isolateModules(() => {
                const loaded = jest.requireActual<BuildReact>('../scripts/build-react');
                options = {
                    commonOptions: loaded.commonOptions,
                    entryPoints: loaded.entryPoints,
                    perEntryOptions: loaded.perEntryOptions,
                };
            });
            return options!;
        } finally {
            if (saved === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = saved;
        }
    };

    // Build one entry's graph in-process and return its inputs normalised to
    // root-relative slash paths, alongside the entry itself normalised the
    // same way.
    const buildGraph = async (name: EntryName) => {
        const esbuild = jest.requireActual<typeof import('esbuild')>('esbuild');
        const { commonOptions, entryPoints, perEntryOptions } = loadBuildOptions();
        const result = await esbuild.build({
            ...commonOptions,
            ...perEntryOptions[name],
            entryPoints: [entryPoints[name]],
            metafile: true,
            write: false,
            logLevel: 'silent',
            // The build script runs from the repository root: the metafile keys
            // are relative to it and the alias map resolves from here.
            absWorkingDir: root,
        });
        const inputs = Object.keys(result.metafile!.inputs).map((input) =>
            path.relative(root, path.resolve(root, input)).split(path.sep).join('/'),
        );
        const entryRel = path.relative(root, path.resolve(root, entryPoints[name])).split(path.sep).join('/');
        return { inputs, entryRel };
    };

    test('no renderer bundle pulls in the platform layer or the native services', async () => {
        const offenders: string[] = [];
        for (const name of CHECKED_ENTRIES) {
            const { inputs, entryRel } = await buildGraph(name);
            // Positive control: each checked graph contains its own entry,
            // normalised exactly like the forbidden paths — if the
            // normalisation or the metafile key format drifts, the check
            // below would silently pass on nothing.
            expect(inputs).toContain(entryRel);
            for (const input of inputs) {
                if (FORBIDDEN_EXACT.includes(input) || input.startsWith(FORBIDDEN_DIR))
                    offenders.push(`${name}: ${input}`);
            }
        }
        expect(offenders).toEqual([]);
    }, 120_000);

    test('the capacitor bundle is the sanctioned route to the platform port and the native bridge', async () => {
        // The Capacitor page legitimately reaches both through
        // src/ts/shells/capacitor/bridge/capacitorBackgroundHost.ts. Their presence — built
        // with the same options and read through the same normalisation — is
        // the positive control that the forbidden-path check sees real
        // module graphs, not an empty match set.
        const { inputs } = await buildGraph('capacitor');
        expect(inputs).toContain('src/ts/core/platform/port.ts');
        expect(inputs).toContain('src/ts/shells/capacitor/NativeAutovoteBridge.ts');
    }, 120_000);

    // One predicate, two callers: the real remote-bundle gate and its negative control must
    // exercise the same check, so the control proves the gate can fail, not a copy of it.
    // Inputs are root-relative slash paths, the same normalisation buildGraph produces.
    const isForbiddenRemoteInput = (input: string): boolean =>
        input === 'src/ts/core/logger.ts' || input.startsWith('src/ts/core/logger/') || input.startsWith('node:');

    test('the remote phone page bundle stays free of the logger and any Node-side chain', async () => {
        // The remote page installs no platform (the logger reads platform() at load and would
        // throw) and runs in the phone's browser, where no Node module exists. How a `node:`
        // import can surface: the remote entry externalizes the Node built-ins
        // (RENDERER_EXTERNALS), so an import of a covered builtin stays out of the metafile and
        // would only fail at runtime ("require is not defined") — the node: filter below then
        // never sees it. If a builtin ever loses its external entry, esbuild either resolves it
        // into the graph (this check fails on the input) or fails the unresolved import at build
        // time — esbuild.build below throws, and that failure is the gate too.
        const { inputs, entryRel } = await buildGraph('remote');
        // Positive control: the graph holds the bridge module this gate exists for, named by the
        // same normalisation the forbidden check uses — if the metafile key format drifted, the
        // filter below would silently pass on nothing.
        expect(inputs).toContain('src/ts/shells/remote/bridge/apiSurface.ts');
        expect(inputs).toContain(entryRel);
        const offenders = inputs.filter(isForbiddenRemoteInput);
        expect(offenders).toEqual([]);
    }, 120_000);

    test('the remote-bundle forbidden-input check fails on a graph that carries the logger or a Node builtin', () => {
        // A check whose failure branch is never exercised proves nothing: this negative control
        // runs the SAME predicate the remote-bundle test uses over a synthetic graph and expects
        // it to catch exactly the forbidden entries — one per predicate branch (the exact logger
        // path, the logger directory prefix, the node: prefix) — while the sanctioned remote
        // modules stay out of the offender list.
        const SYNTHETIC_INPUTS = [
            'src/ts/shells/remote/page.tsx',
            'src/ts/shells/remote/bridge/apiSurface.ts',
            'src/ts/core/logger.ts',
            'src/ts/core/logger/context.ts',
            'node:fs',
        ] as const;
        const offenders = SYNTHETIC_INPUTS.filter(isForbiddenRemoteInput);
        expect(offenders).toEqual(['src/ts/core/logger.ts', 'src/ts/core/logger/context.ts', 'node:fs']);
    });
});

// Every shell platform module must install before the logger loads: the
// logger reads platform() at module scope (logger/context's context rules),
// so one static logger import anywhere in a shell platform module's load-time
// chain throws before the install runs — the bundled Electron main crashed at
// startup exactly that way. The families' call-time requires are the
// documented exception (they run when a member is called, never at load), so
// the guard walks only esbuild's import-statement edges — never require-call
// or dynamic-import edges — and fails on any logger module they reach.
describe('shell platform module load-time chains', () => {
    // tests/setup.ts mocks fs and path globally; esbuild's client resolves paths for real.
    jest.unmock('fs');
    jest.unmock('path');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const root = path.join(__dirname, '..');

    const SHELL_PLATFORM_ENTRIES = [
        'src/ts/shells/electron/platform.ts',
        'src/ts/shells/cli/platform.ts',
        'src/ts/shells/web/platform.ts',
        'src/ts/shells/capacitor/platform.ts',
        'src/ts/shells/headless/platform.ts',
        'scripts/lib/platform.ts',
    ];
    const LOGGER_ENTRY = 'src/ts/core/logger.ts';
    const isLoggerModule = (file: string): boolean => file === LOGGER_ENTRY || file.startsWith('src/ts/core/logger/');

    // Bundles one entry in-process and walks its metafile graph over
    // import-statement edges only, answering every reached file normalised to
    // root-relative slash paths, entry included.
    const loadTimeChain = async (entry: string): Promise<string[]> => {
        const esbuild = jest.requireActual<typeof import('esbuild')>('esbuild');
        const result = await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            metafile: true,
            write: false,
            logLevel: 'silent',
            // The metafile keys are relative to the repository root; the
            // normalisation below matches them.
            absWorkingDir: root,
            external: ['electron', '@capacitor/*', '@capawesome-team/*'],
        });
        const importsOf = new Map<string, string[]>();
        for (const [file, info] of Object.entries(result.metafile!.inputs)) {
            const normalised = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
            importsOf.set(
                normalised,
                (info.imports ?? [])
                    .filter((imp) => imp.kind === 'import-statement' && !imp.external)
                    .map((imp) => path.relative(root, path.resolve(root, imp.path)).split(path.sep).join('/')),
            );
        }
        const reached = new Set<string>([entry]);
        const queue = [entry];
        while (queue.length > 0) {
            const file = queue.shift()!;
            for (const next of importsOf.get(file) ?? []) {
                if (reached.has(next)) continue;
                reached.add(next);
                queue.push(next);
            }
        }
        return [...reached];
    };

    test('no shell platform module reaches the logger through its load-time imports', async () => {
        const offenders: string[] = [];
        const portMisses: string[] = [];
        for (const entry of SHELL_PLATFORM_ENTRIES) {
            const chain = await loadTimeChain(entry);
            // Per-entry control: every shell platform module statically
            // imports the port it installs, so the walk must reach it
            // through a real edge — a walk that followed no edges, or that
            // normalised one entry's paths wrongly, fails here. The
            // assertion requires each shell platform module to import the
            // port statically, so a module that installs another way fails
            // it on purpose.
            if (!chain.includes('src/ts/core/platform/port.ts')) portMisses.push(entry);
            offenders.push(...chain.filter(isLoggerModule).map((file) => `${entry}: ${file}`));
        }
        expect(portMisses).toEqual([]);
        expect(offenders).toEqual([]);
    }, 120_000);

    test('the guard is honest: the Electron entry does reach the logger, and the check names it', async () => {
        // The mechanism control: src/ts/shells/electron/index.ts imports the settings facade
        // statically, and the facade reaches the logger — the same-shaped
        // graph that broke the main bundle. Its presence here, named by the
        // same filter the guard fails on, proves the walk and the check see
        // real logger modules.
        const chain = await loadTimeChain('src/ts/shells/electron/index.ts');
        expect(chain).toContain(LOGGER_ENTRY);
        expect(chain.filter(isLoggerModule)).toContain(LOGGER_ENTRY);
    }, 120_000);
});
