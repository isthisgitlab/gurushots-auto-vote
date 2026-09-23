/**
 * Unit tests for scripts/check-size-delta.js.
 *
 * The script measures dist/*-bundle.js with real zlib brotli and compares the
 * sizes against .size-baseline.json. fs is replaced by an in-memory file map
 * so neither dist/ nor the committed baseline is ever read or written; each
 * case requires the script in an isolated registry (it runs main() at require
 * time) with process.exit stubbed to throw so control stops exactly where the
 * real process would.
 */

const realPath = jest.requireActual('path');
const zlib = jest.requireActual('zlib');
const crypto = jest.requireActual('crypto');

jest.mock('path', () => jest.requireActual('path'));

// Shared instance so the copy required inside jest.isolateModules is this one.
const mockFiles = new Map();
const mockFs = {
    existsSync: jest.fn((p) => mockFiles.has(p)),
    readFileSync: jest.fn((p, enc) => {
        if (!mockFiles.has(p)) {
            const err = new Error(`ENOENT: ${p}`);
            err.code = 'ENOENT';
            throw err;
        }
        const data = mockFiles.get(p);
        return enc ? String(data) : Buffer.from(data);
    }),
    writeFileSync: jest.fn((p, data) => {
        mockFiles.set(p, data);
    }),
};
jest.mock('fs', () => mockFs);

const ROOT = realPath.join(__dirname, '..', '..');
const BASELINE = realPath.join(ROOT, '.size-baseline.json');
const NAMES = ['app', 'login', 'logs', 'capacitor', 'headless', 'preload'];
const bundlePath = (name) => realPath.join(ROOT, 'dist', `${name}-bundle.js`);

const brotli = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

// Incompressible payload so brotli size tracks byte length closely.
const payload = (bytes, seed) => {
    const out = Buffer.alloc(bytes);
    let block = crypto.createHash('sha256').update(seed).digest();
    for (let i = 0; i < bytes; i += block.length) {
        block.copy(out, i);
        block = crypto.createHash('sha256').update(block).digest();
    }
    return out;
};

class ExitCalled extends Error {
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}

describe('scripts/check-size-delta.js', () => {
    const originalArgv = process.argv;
    const originalDelta = process.env.SIZE_DELTA_KB;
    let logSpy;
    let errorSpy;
    let sizes;

    beforeEach(() => {
        mockFiles.clear();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new ExitCalled(code);
        });
        delete process.env.SIZE_DELTA_KB;
        sizes = {};
        for (const name of NAMES) {
            const buf = payload(2048, name);
            mockFiles.set(bundlePath(name), buf);
            sizes[name] = brotli(buf);
        }
    });

    afterEach(() => {
        process.argv = originalArgv;
        if (originalDelta === undefined) delete process.env.SIZE_DELTA_KB;
        else process.env.SIZE_DELTA_KB = originalDelta;
        jest.restoreAllMocks();
    });

    const setBaseline = (obj) => mockFiles.set(BASELINE, typeof obj === 'string' ? obj : JSON.stringify(obj));

    const run = (args = []) => {
        process.argv = ['node', 'scripts/check-size-delta.js', ...args];
        try {
            jest.isolateModules(() => {
                require('../../scripts/check-size-delta.js');
            });
        } catch (err) {
            if (err instanceof ExitCalled) return err.code;
            throw err;
        }
        throw new Error('script finished without calling process.exit');
    };

    const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const err = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    test('passes when every bundle is within threshold, flagging shrinkage', () => {
        setBaseline({ ...sizes, app: sizes.app + 500, login: sizes.login - 1000 });

        expect(run()).toBe(0);
        expect(out()).toContain('threshold: +5 kB per bundle');
        expect(out()).toMatch(/app \(Electron renderer\).*-0\.49 kB {2}↓/);
        expect(out()).toMatch(/login \(Electron renderer\).*\+0\.98 kB/);
        expect(out()).toContain('✔ All bundles within +5 kB of baseline.');
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    test('fails on a jump larger than the threshold', () => {
        setBaseline({ ...sizes, capacitor: sizes.capacitor - 6 * 1024 });

        expect(run()).toBe(1);
        expect(out()).toContain('✗ JUMP');
        expect(err()).toContain('A bundle grew by more than +5 kB');
    });

    test('honours SIZE_DELTA_KB', () => {
        process.env.SIZE_DELTA_KB = '8';
        setBaseline({ ...sizes, capacitor: sizes.capacitor - 6 * 1024 });

        expect(run()).toBe(0);
        expect(out()).toContain('threshold: +8 kB per bundle');
    });

    test('fails when a bundle has no baseline entry', () => {
        const { headless, ...rest } = sizes;
        void headless;
        setBaseline(rest);

        expect(run()).toBe(1);
        expect(out()).toContain('(no baseline)');
        expect(err()).toContain('have no baseline entry');
    });

    test('fails when a bundle has not been built', () => {
        setBaseline(sizes);
        mockFiles.delete(bundlePath('logs'));

        expect(run()).toBe(1);
        expect(err()).toContain('✗ logs (Electron renderer): bundle not found at dist/logs-bundle.js');
    });

    test.each([
        ['a missing baseline file', null],
        ['unparseable JSON', '{not json'],
        ['a JSON null', 'null'],
        ['a JSON scalar', '42'],
    ])('treats %s as an empty baseline', (_label, raw) => {
        if (raw !== null) setBaseline(raw);

        expect(run()).toBe(1);
        expect(out().match(/\(no baseline\)/g)).toHaveLength(NAMES.length);
    });

    describe('--update', () => {
        test('rewrites the baseline to the measured sizes, keeping unknown keys, even past the threshold', () => {
            setBaseline({ ...sizes, app: sizes.app - 20 * 1024, retired: 123 });

            expect(run(['--update'])).toBe(0);
            expect(mockFs.writeFileSync).toHaveBeenCalledWith(BASELINE, expect.any(String), 'utf8');
            const written = mockFiles.get(BASELINE);
            expect(written.endsWith('\n')).toBe(true);
            expect(JSON.parse(written)).toEqual({ ...sizes, retired: 123 });
            expect(written).toBe(`${JSON.stringify({ ...sizes, retired: 123 }, null, 4)}\n`);
            expect(out()).toContain('✔ Baseline updated');
            expect(err()).toBe('');
        });

        test('writes what it could measure but exits 1 when a bundle is missing', () => {
            mockFiles.delete(bundlePath('preload'));

            expect(run(['--update'])).toBe(1);
            const { preload, ...rest } = sizes;
            void preload;
            expect(JSON.parse(mockFiles.get(BASELINE))).toEqual(rest);
            expect(err()).toContain('bundle not found at dist/preload-bundle.js');
        });
    });
});
