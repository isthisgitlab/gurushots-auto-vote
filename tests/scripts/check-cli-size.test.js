/**
 * Tests for scripts/check-cli-size.js — the coarse SEA CLI size guard.
 *
 * Artifacts are real files in an os.tmpdir() sandbox (sparse via truncate, so
 * "over budget" costs no disk); process.exit is stubbed so the exit code can
 * be asserted without killing the Jest worker.
 */

// tests/setup.js globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, check, MAX_BUNDLE_MB, MAX_BINARY_MB } = require('../../scripts/check-cli-size');

const MB = 1024 * 1024;

describe('check-cli-size', () => {
    let tmp;
    let bundlePath;
    let cliBuildDir;
    let exitSpy;
    let logSpy;
    let errorSpy;

    const writeSized = (filePath, bytes) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '');
        fs.truncateSync(filePath, bytes);
    };

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-cli-size-'));
        bundlePath = path.join(tmp, 'dist', 'cli-bundled.js');
        cliBuildDir = path.join(tmp, 'build', 'cli');
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('exits 0 with a notice when no artifacts exist', () => {
        main({ bundlePath, cliBuildDir });
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No CLI artifacts found'));
    });

    test('exits 0 when the build dir exists but holds no gurucli binaries', () => {
        writeSized(path.join(cliBuildDir, 'other-file'), 10);
        main({ bundlePath, cliBuildDir });
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('passes when every artifact is within budget', () => {
        writeSized(bundlePath, 1024);
        writeSized(path.join(cliBuildDir, 'gurucli-v1-mac'), 2 * MB);
        writeSized(path.join(cliBuildDir, 'unrelated.txt'), 10);
        main({ bundlePath, cliBuildDir });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✅ ok  build/cli/gurucli-v1-mac: 2.0 MB'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('All 2 CLI artifact(s) within budget'));
    });

    test('exits 1 when an artifact is over budget', () => {
        writeSized(bundlePath, MAX_BUNDLE_MB * MB + 1);
        writeSized(path.join(cliBuildDir, 'gurucli-v1-linux'), MAX_BINARY_MB * MB + 1);
        main({ bundlePath, cliBuildDir });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('2 CLI artifact(s) over budget'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('❌ OVER  dist/cli-bundled.js'));
    });

    test('check returns false and leaves the tally alone for a missing file', () => {
        const tally = { checked: 0, failed: 0 };
        expect(check('x', path.join(tmp, 'missing'), 1, tally)).toBe(false);
        expect(tally).toEqual({ checked: 0, failed: 0 });
    });

    test('main defaults to the repo artifact paths', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        main();
        expect(existsSpy).toHaveBeenCalledWith(path.join(__dirname, '..', '..', 'dist', 'cli-bundled.js'));
        expect(existsSpy).toHaveBeenCalledWith(path.join(__dirname, '..', '..', 'build', 'cli'));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('requiring the module has no side effects', () => {
        jest.isolateModules(() => {
            require('../../scripts/check-cli-size');
        });
        expect(logSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
