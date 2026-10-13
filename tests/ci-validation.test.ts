/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */
import { isPlainObject } from '../src/ts/plainObject';

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
    // restrictToLogsChannels (ipc/registerHandlers.ts) filters only `webContents.send`; the frame-guard Oxlint rule
    // (scripts/lint/frame-guard.mts) keeps every other route to a window out of src/ts. Switching it off, or widening
    // its exemptions, has to show up here.
    test('Oxlint runs the frame-guard rule over all of src/ts with no file exempt', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        const root = path.join(__dirname, '..');
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
    });

    // The only legitimate frame reads and off-window sends, each a line-level disable with a reason.
    const EXEMPTIONS: ReadonlyArray<readonly [string, string]> = [
        ['src/ts/ipc/registerHandlers.ts', 'const frame = event.senderFrame;'],
        [
            'src/ts/ipc/registerHandlers.ts',
            'if (event.sender?.mainFrame && frame !== event.sender.mainFrame) return false;',
        ],
        ['src/ts/ipc/registerHandlers.ts', "return event.senderFrame?.url ?? event.sender?.getURL?.() ?? '<unknown>';"],
        ['src/ts/preloadApi.ts', 'api[method] = () => ipcRenderer.send(channel);'],
    ];

    test('the frame-guard disable comments in src/ts are exactly the pinned set, each with a reason', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const root = path.join(__dirname, '..');
        const found: Array<readonly [string, string]> = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!/\.tsx?$/.test(entry.name)) continue;
                const lines = fs.readFileSync(full, 'utf8').split('\n');
                lines.forEach((line, index) => {
                    // Anything on a line that names the rule next to a disable directive counts.
                    if (!/(?:oxlint|eslint)-disable/.test(line) || !line.includes('frame-guard')) return;
                    const directive =
                        /^\s*\/\/ oxlint-disable-next-line frame-guard\/no-unfiltered-frame-send -- \S.*$/;
                    expect(line).toMatch(directive);
                    found.push([path.relative(root, full), lines[index + 1].trim()]);
                });
            }
        };
        walk(path.join(root, 'src/ts'));
        expect(found.sort()).toEqual([...EXEMPTIONS].sort());
    });

    // A directive that names no rule switches off every rule, frame-guard included.
    const bareDisableLines = (text: string): number[] => {
        const bare: number[] = [];
        text.split('\n').forEach((line, index) => {
            const match = /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])(.*)$/.exec(line);
            if (!match) return;
            // What follows the directive, minus a block comment's close and a `-- reason`.
            const rules = match[1].split('*/')[0].split(/\s--(?:\s|$)/)[0];
            if (rules.trim() === '') bare.push(index + 1);
        });
        return bare;
    };

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
        ].join('\n');
        expect(bareDisableLines(sample)).toEqual([1, 2, 3, 4]);
    });

    test('every disable directive in src/ts names the rule it silences', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const root = path.join(__dirname, '..');
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) {
                    for (const line of bareDisableLines(fs.readFileSync(full, 'utf8'))) {
                        offenders.push(`${path.relative(root, full)}:${line}`);
                    }
                }
            }
        };
        walk(path.join(root, 'src/ts'));
        expect(offenders).toEqual([]);
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
        const { THEMES } = jest.requireActual<typeof import('../src/ts/settings/uiDefaults')>(
            '../src/ts/settings/uiDefaults',
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
