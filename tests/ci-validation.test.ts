/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */
import { isPlainObject } from '../src/ts/plainObject';
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
    // restrictToLogsChannels (ipc/registerHandlers.ts) filters only `webContents.send`; the frame-guard Oxlint rule
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
        expect(config.ignorePatterns).toEqual(['src/ts/types/**']);
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
        expect(scripts.lint).toBe('oxlint src scripts tests');
    });

    // Oxlint ignores src/ts/types, so nothing there may run: every top-level statement is a type declaration.
    test('src/ts/types holds only type declarations', () => {
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
        const files = fs.globSync('src/ts/types/**/*.{ts,tsx}', { cwd: root });
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
        ['src/ts/ipc/registerHandlers.ts', 'const frame = event.senderFrame;'],
        [
            'src/ts/ipc/registerHandlers.ts',
            'if (event.sender?.mainFrame && frame !== event.sender.mainFrame) return false;',
        ],
        ['src/ts/ipc/registerHandlers.ts', "return event.senderFrame?.url ?? event.sender?.getURL?.() ?? '<unknown>';"],
        ['src/ts/ipc/registerHandlers.ts', 'webContents.send = (channel: string, ...args: unknown[]) =>'],
        ['src/ts/preloadApi.ts', 'api[method] = () => ipcRenderer.send(channel);'],
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
