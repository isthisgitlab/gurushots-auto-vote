/**
 * Tests for runtime headless-service detection. The Android background
 * service runs the JS in a bare WebView (no Capacitor runtime) and
 * injects a global flag so the storage + HTTP layers know to use the
 * native bridges instead of @capacitor/preferences / CapacitorHttp.
 */

const runtime = require('../src/js/runtime');

describe('runtime.isHeadlessService', () => {
    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
    });

    test('is false when the native flag is absent', () => {
        expect(runtime.isHeadlessService()).toBe(false);
    });

    test('is true when the native headless flag is injected', () => {
        globalThis.__GS_HEADLESS__ = true;
        expect(runtime.isHeadlessService()).toBe(true);
    });

    test('getPlatform reports "headless" when the flag is set', () => {
        globalThis.__GS_HEADLESS__ = true;
        expect(runtime.getPlatform()).toBe('headless');
    });
});

// The consolidated app-identity/user-data resolution (previously duplicated
// with DIVERGING Electron dev branches in logger.js and settings/storage.js)
// now decides where logs AND settings physically live — pin each branch.
describe('runtime app identity + user-data path (single source of truth)', () => {
    const fs = require('fs');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('isSourceCode is true under Jest (no Electron, no SEA, no asar)', () => {
        expect(runtime.isSourceCode()).toBe(true);
    });

    test('getAppName carries the -dev suffix when running from source', () => {
        expect(runtime.getAppName()).toBe('gurushots-auto-vote-dev');
    });

    test('CLI branch resolves the platform dir for the dev app name and ensures it exists', () => {
        fs.existsSync.mockReturnValue(false);

        const result = runtime.getAppUserDataPath();

        expect(result).toBe(runtime.getUserDataDir('gurushots-auto-vote-dev'));
        expect(fs.mkdirSync).toHaveBeenCalledWith(result, { recursive: true });
    });

    test('CLI branch skips mkdir when the directory already exists', () => {
        fs.existsSync.mockReturnValue(true);

        runtime.getAppUserDataPath();

        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('CLI branch falls back to cwd/userData when the platform dir cannot be created', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        fs.existsSync.mockReturnValue(false);
        fs.mkdirSync
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            })
            .mockImplementationOnce(() => {});

        const result = runtime.getAppUserDataPath();

        expect(result).toBe(`${process.cwd()}/userData`);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to cwd/userData'));
        warnSpy.mockRestore();
    });

    describe('Electron branch (simulated via process.versions.electron + virtual electron module)', () => {
        // runtime gates the Electron path on process.versions.electron and a
        // guarded require('electron') — fake both, per test, via resetModules.
        const withElectron = (appStub, fn) => {
            jest.isolateModules(() => {
                process.versions.electron = '43.0.0';
                jest.doMock('electron', () => ({ app: appStub }), { virtual: true });
                try {
                    fn(require('../src/js/runtime'));
                } finally {
                    delete process.versions.electron;
                    jest.dontMock('electron');
                }
            });
        };

        test('packaged app: isSourceCode false, plain userData path, no -dev suffix', () => {
            withElectron({ isPackaged: true, getPath: () => '/ud/GuruShotsAutoVote' }, (rt) => {
                expect(rt.isSourceCode()).toBe(false);
                expect(rt.getAppName()).toBe('gurushots-auto-vote');
                expect(rt.getAppUserDataPath()).toBe('/ud/GuruShotsAutoVote');
            });
        });

        test('dev-from-source: -dev appended to the userData basename (canonical dev form)', () => {
            withElectron({ isPackaged: false, getPath: () => '/ud/GuruShotsAutoVote' }, (rt) => {
                expect(rt.isSourceCode()).toBe(true);
                expect(rt.getAppUserDataPath()).toBe('/ud/GuruShotsAutoVote-dev');
            });
        });
    });
});
