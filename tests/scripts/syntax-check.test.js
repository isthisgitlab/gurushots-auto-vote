/**
 * Tests for scripts/syntax-check.js. Hermetic: `node --check` is never
 * actually spawned (execFileSync is mocked), and directory walks run over
 * temp dirs under os.tmpdir() — except one read-only walk of the real
 * project roots to pin the default include list.
 */

// tests/setup.js mocks fs/path globally; the walker needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { main, checkFileSyntax, getJsFiles, shouldExclude } = require('../../scripts/syntax-check.js');

let tmp;
let logSpy;
let exitSpy;

beforeEach(() => {
    execFileSync.mockReset();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-check-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const touch = (rel, body = '') => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
};

describe('getJsFiles', () => {
    test('returns [] for a missing directory', () => {
        expect(getJsFiles(path.join(tmp, 'missing'))).toEqual([]);
    });

    test('recurses into subdirectories and keeps only regular .js files', () => {
        const a = touch('a.js');
        const b = touch('nested/deep/b.js');
        touch('notes.txt');
        // A symlink is neither a directory nor a regular file for Dirent.
        fs.symlinkSync(a, path.join(tmp, 'link.js'));

        expect(getJsFiles(tmp).sort()).toEqual([a, b].sort());
    });
});

describe('shouldExclude', () => {
    test('matches exact excluded files and excluded directory prefixes', () => {
        expect(shouldExclude('src/js/index.js')).toBe(true);
        expect(shouldExclude(['src', 'js', 'react', 'App.js'].join(path.sep))).toBe(true);
        expect(shouldExclude('scripts/site/x.js')).toBe(true);
        expect(shouldExclude('src/js/settings.js')).toBe(false);
    });
});

describe('checkFileSyntax', () => {
    test('runs node --check without a shell and reports success', () => {
        expect(checkFileSyntax('f.js')).toEqual({ success: true });
        expect(execFileSync).toHaveBeenCalledWith(process.execPath, ['--check', 'f.js'], { stdio: 'pipe' });
    });

    test('reports stderr from a failing check', () => {
        execFileSync.mockImplementation(() => {
            const err = new Error('exit 1');
            err.stderr = Buffer.from('SyntaxError: nope');
            throw err;
        });

        expect(checkFileSyntax('f.js')).toEqual({ success: false, error: 'SyntaxError: nope' });
    });

    test('falls back to the error message when there is no stderr', () => {
        execFileSync.mockImplementation(() => {
            throw new Error('spawn failed');
        });

        expect(checkFileSyntax('f.js')).toEqual({ success: false, error: 'spawn failed' });
    });
});

describe('main', () => {
    test('exits 0 silently when every file passes (deduplicating overlapping roots)', () => {
        touch('ok.js');
        touch('sub/ok2.js');

        main([tmp, path.join(tmp, 'sub')]);

        expect(execFileSync).toHaveBeenCalledTimes(2);
        expect(logSpy).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('prints each failure and exits 1', () => {
        const bad = touch('bad.js');
        touch('good.js');
        execFileSync.mockImplementation((_node, [, file]) => {
            if (file === bad) {
                const err = new Error('exit 1');
                err.stderr = Buffer.from('  SyntaxError: bad  \n');
                throw err;
            }
        });

        main([tmp]);

        const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain(bad);
        expect(output).toContain('SyntaxError: bad');
        expect(output).toContain('1 syntax error(s) found:');
        expect(exitSpy.mock.calls[0][0]).toBe(1);
    });

    test('defaults to the project roots and skips the ESM/JSX islands', () => {
        main();

        const checked = execFileSync.mock.calls.map(([, [, file]]) => file.split(path.sep).join('/'));
        expect(checked).toContain('scripts/syntax-check.js');
        expect(checked).not.toContain('src/js/index.js');
        expect(checked.some((f) => f.startsWith('src/js/react/'))).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
