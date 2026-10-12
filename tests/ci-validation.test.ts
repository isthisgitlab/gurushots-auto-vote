/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */

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
    // restrictToLogsChannels (ipc/registerHandlers.ts) filters only `webContents.send`; `postMessage`, a frame's
    // `send` (`mainFrame.send`, `frames[i].send`, `sendToFrame`, or `send` on a stored frame handle), an event's
    // `reply` and a `webFrameMain` handle reach a window unfiltered, so no source may touch a frame handle
    // (`mainFrame`, `senderFrame`, `framesInSubtree`, `webFrameMain`), call `send` on anything but `webContents`,
    // reply on an event or post a message. A legitimate line is listed here as `relative/path.ts`, with the text of
    // the line and the reason.
    const ALLOWED: Readonly<Record<string, readonly string[]>> = {
        // The trusted-sender check and the refusal log read the sender's frame (its url, and whether it is the window's
        // main frame); they send nothing.
        'ipc/registerHandlers.ts': [
            'event.sender?.mainFrame && frame !== event.sender.mainFrame',
            '`postMessage` and `mainFrame.send` are not',
            'Read senderFrame inside the try',
            'const frame = event.senderFrame;',
            'event.senderFrame?.url ??',
        ],
        // The preload's one-way send to the main process (renderer side, not a window).
        'preloadApi.ts': ['ipcRenderer.send(channel)'],
    };
    const UNFILTERED_SEND_RE =
        /\bpostMessage\(|\bmainFrame\b|\bsenderFrame\b|\bframesInSubtree\b|\bsendToFrame\(|\bwebFrameMain\b|\bframes\[[^\]]*\]\??\.send\(|(?<!\bwebContents\??)\.send\(|\.reply\(/g;
    const SOURCE_FILE_RE = /\.(?:[cm]?ts|tsx)$/;
    const hitLines = (text: string) => [
        ...new Set(
            [...text.matchAll(UNFILTERED_SEND_RE)].map((match) => text.slice(0, match.index).split('\n').length),
        ),
    ];
    const unfilteredSends = (text: string, allowedLines: readonly string[] = []) => {
        const lines = text.split('\n');
        return hitLines(text).filter((line) => !allowedLines.some((allowed) => lines[line - 1].includes(allowed)));
    };

    test('no source uses postMessage, a frame handle (mainFrame, senderFrame, framesInSubtree, webFrameMain, sendToFrame), a send off webContents, or .reply(', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        const srcDir = path.join(__dirname, '..', 'src', 'ts');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (SOURCE_FILE_RE.test(entry.name)) {
                    const relative = path.relative(srcDir, full);
                    for (const line of unfilteredSends(fs.readFileSync(full, 'utf8'), ALLOWED[relative])) {
                        offenders.push(`${relative}:${line}`);
                    }
                }
            }
        };
        walk(srcDir);
        expect(offenders).toEqual([]);
    });

    const staleAllowances = (
        allowed: Readonly<Record<string, readonly string[]>>,
        read: (relative: string) => string,
    ) => {
        const stale: string[] = [];
        for (const [relative, allowedLines] of Object.entries(allowed)) {
            const text = read(relative);
            const lines = text.split('\n');
            for (const entry of allowedLines) {
                if (!hitLines(text).some((line) => lines[line - 1].includes(entry)))
                    stale.push(`${relative}: ${entry}`);
            }
        }
        return stale;
    };

    test('every allowed line still matches the check in its file, so none goes stale', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        expect(
            staleAllowances(ALLOWED, (relative) =>
                fs.readFileSync(path.join(__dirname, '..', 'src', 'ts', relative), 'utf8'),
            ),
        ).toEqual([]);
    });

    test('an allowance that matches no flagged line is reported as stale', () => {
        const text = 'const frame = event.senderFrame;\nconst fine = 1;';
        expect(
            staleAllowances({ 'a.ts': ['event.senderFrame;', 'const fine = 1;', 'removed line'] }, () => text),
        ).toEqual(['a.ts: const fine = 1;', 'a.ts: removed line']);
    });

    test('the check catches each unfiltered send, and passes the filtered one', () => {
        for (const offender of [
            'win.webContents.mainFrame.send("c", x);',
            'event.sender.mainFrame?.send("c", x);',
            'window.postMessage(data, "*");',
            'postMessage(data);',
            'sendToFrame(frameId, "c", x);',
            'const { webFrameMain } = require("electron");',
            'win.webContents.mainFrame.frames[0].send("c", x);',
            'frames[i]?.send("c", x);',
            'const frame = win.webContents.mainFrame;',
            'const frames = win.webContents.mainFrame.framesInSubtree;',
            'const all = framesInSubtree;',
            'const frame = event.senderFrame;',
            'event.reply("c", x);',
            'const frame = event.senderFrame; frame.send("x");',
            'frame.send("c", x);',
            'port?.send("c", x);',
        ]) {
            expect(unfilteredSends(`ok\n${offender}`)).toEqual([2]);
        }
        expect(
            unfilteredSends('a\nconst frame = sender.mainFrame; // checked', ['sender.mainFrame; // checked']),
        ).toEqual([]);
        expect(
            unfilteredSends(
                'win.webContents.send("c", x);\nwin.webContents?.send("c", x);\nconst postMessageCount = 1;',
            ),
        ).toEqual([]);
    });

    test('every TypeScript source extension is scanned', () => {
        for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) expect(SOURCE_FILE_RE.test(name)).toBe(true);
        expect(SOURCE_FILE_RE.test('a.js')).toBe(false);
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
