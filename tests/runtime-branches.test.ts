/**
 * Branch coverage for runtime.ts platform detection, env flags and path
 * resolution. Platform-specific inputs (process.versions, process.platform,
 * g.Capacitor, the electron / node:sea modules) are faked per test
 * and every module load that depends on them goes through isolateModules.
 */

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import type * as runtimeModule from '../src/ts/runtime';
import type * as node_osModule from 'node:os';
import { invalid } from './helpers/invalid';

const g = globalThis as typeof globalThis & { Capacitor?: unknown };

const setProp = (obj: object, key: PropertyKey, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(obj, key);
    Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
    return () => Object.defineProperty(obj, key, invalid<PropertyDescriptor>(original));
};

const restorers: (() => unknown)[] = [];
const withProp = (obj: object, key: PropertyKey, value: unknown) => restorers.push(setProp(obj, key, value));

// runtime require()s electron / node:sea lazily inside its functions, so the
// assertions must run INSIDE the isolated registry — once isolateModules
// returns, a lazy require would hit (and poison) the shared registry.
const withRuntime = (
    { electron, sea }: { electron?: () => unknown; sea?: () => unknown } = {},
    fn: (rt: typeof runtimeModule) => void,
) => {
    jest.isolateModules(() => {
        if (electron !== undefined) jest.doMock('electron', electron, { virtual: true });
        if (sea !== undefined) jest.doMock('node:sea', sea, { virtual: true });
        fn(require('../src/ts/runtime') as typeof runtimeModule);
    });
};
const loadRuntime = () => {
    let rt!: typeof runtimeModule;
    jest.isolateModules(() => {
        rt = require('../src/ts/runtime') as typeof rt;
    });
    return rt;
};

const envKeys = ['NODE_ENV', 'DEV', 'PROD', 'APPDATA'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
});

afterEach(() => {
    while (restorers.length) restorers.pop()!();
    for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    delete g.Capacitor;
    delete (process.versions as { electron?: string }).electron;
    jest.dontMock('electron');
    jest.dontMock('node:sea');
});

const capacitor = (platform = 'android', native = true) => ({
    isNativePlatform: () => native,
    getPlatform: () => platform,
});

describe('platform detection', () => {
    test('plain Node is the CLI platform', () => {
        const rt = loadRuntime();
        expect(rt.isCli()).toBe(true);
        expect(rt.getPlatform()).toBe('cli');
    });

    test('Electron wins over CLI', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        const rt = loadRuntime();
        expect(rt.isElectron()).toBe(true);
        expect(rt.isCli()).toBe(false);
        expect(rt.getPlatform()).toBe('electron');
    });

    test("the WebView bundles' process stub (type 'browser', no Electron version) is not Electron", () => {
        (process as { type?: string }).type = 'browser';
        try {
            expect(loadRuntime().isElectron()).toBe(false);
        } finally {
            delete (process as { type?: string }).type;
        }
    });

    test('Capacitor is detected only when isNativePlatform is a function', () => {
        const rt = loadRuntime();
        g.Capacitor = {};
        expect(rt.isCapacitor()).toBe(false);
        g.Capacitor = capacitor();
        expect(rt.isCapacitor()).toBe(true);
    });

    test('a WebView without Node reports capacitor, then unknown without Capacitor', () => {
        withProp(process, 'versions', undefined);
        const rt = loadRuntime();
        g.Capacitor = capacitor('android');
        expect(rt.getPlatform()).toBe('capacitor');
        delete g.Capacitor;
        expect(rt.isElectron()).toBe(false);
        expect(rt.isCli()).toBe(false);
        expect(rt.getPlatform()).toBe('unknown');
    });
});

describe('isPackaged', () => {
    test('Electron: reads app.isPackaged', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        withRuntime({ electron: () => ({ app: { isPackaged: true } }) }, (rt) => expect(rt.isPackaged()).toBe(true));
    });

    test('Electron: an unloadable electron module means not packaged', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        withRuntime(
            {
                electron: () => {
                    throw new Error('no electron');
                },
            },
            (rt) => expect(rt.isPackaged()).toBe(false),
        );
    });

    test('Capacitor: native platform counts as packaged', () => {
        const rt = loadRuntime();
        g.Capacitor = capacitor('android', true);
        expect(rt.isPackaged()).toBe(true);
    });

    test('plain Node is never packaged', () => {
        expect(loadRuntime().isPackaged()).toBe(false);
    });
});

describe('env flags', () => {
    const rt = require('../src/ts/runtime') as typeof runtimeModule;

    test.each([
        [{ NODE_ENV: 'development' }, true],
        [{ NODE_ENV: 'dev' }, true],
        [{ NODE_ENV: 'x', DEV: 'true' }, true],
        [{ NODE_ENV: 'x', DEV: '1' }, true],
        [{ NODE_ENV: 'x', DEV: 'no' }, false],
    ])('isDevelopment(%o) -> %s', (env, expected) => {
        delete process.env.DEV;
        Object.assign(process.env, env);
        expect(rt.isDevelopment()).toBe(expected);
    });

    test('isTest and getEnvSnapshot read the live env', () => {
        process.env.NODE_ENV = 'test';
        process.env.DEV = '1';
        process.env.PROD = '0';
        expect(rt.isTest()).toBe(true);
        expect(rt.getEnvSnapshot()).toEqual({ nodeEnv: 'test', dev: '1', prod: '0' });
        process.env.NODE_ENV = 'production';
        expect(rt.isTest()).toBe(false);
    });
});

describe('getUserDataDir', () => {
    const os = require('node:os') as typeof node_osModule;
    const rt = require('../src/ts/runtime') as typeof runtimeModule;

    test('Capacitor returns a stub path without touching the OS', () => {
        g.Capacitor = capacitor();
        expect(rt.getUserDataDir('app')).toBe('/app');
    });

    test('macOS uses Application Support', () => {
        withProp(process, 'platform', 'darwin');
        expect(rt.getUserDataDir('app')).toBe(`${os.homedir()}/Library/Application Support/app`);
    });

    test('Windows uses APPDATA, falling back to the roaming profile dir', () => {
        withProp(process, 'platform', 'win32');
        process.env.APPDATA = 'C:/Users/u/AppData/Roaming';
        expect(rt.getUserDataDir('app')).toBe('C:/Users/u/AppData/Roaming/app');
        delete process.env.APPDATA;
        expect(rt.getUserDataDir('app')).toBe(`${os.homedir()}/AppData/Roaming/app`);
    });

    test('other platforms use ~/.config', () => {
        withProp(process, 'platform', 'linux');
        expect(rt.getUserDataDir('app')).toBe(`${os.homedir()}/.config/app`);
    });
});

describe('isSourceCode', () => {
    test('a SEA binary is not source', () => {
        withRuntime({ sea: () => ({ isSea: () => true }) }, (rt) => expect(rt.isSourceCode()).toBe(false));
    });

    test('Electron without an app object (run-as-node) falls through to source detection', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        withRuntime({ electron: () => ({}) }, (rt) => expect(rt.isSourceCode()).toBe(true));
    });

    test('Electron module that fails to load is treated as source', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        withRuntime(
            {
                electron: () => {
                    throw new Error('no electron');
                },
            },
            (rt) => expect(rt.isSourceCode()).toBe(true),
        );
    });
});

describe('getAppUserDataPath', () => {
    beforeEach(() => {
        fs.existsSync.mockReset();
        fs.mkdirSync.mockReset();
    });

    test('Electron app without getPath falls back to the CLI resolution', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        fs.existsSync.mockReturnValue(true);
        withRuntime({ electron: () => ({ app: { isPackaged: false } }) }, (rt) =>
            expect(rt.getAppUserDataPath()).toBe(rt.getUserDataDir('gurushots-auto-vote-dev')),
        );
    });

    test('Electron module that throws falls back to the CLI resolution', () => {
        (process.versions as { electron?: string }).electron = '43.0.0';
        fs.existsSync.mockReturnValue(true);
        withRuntime(
            {
                electron: () => {
                    throw new Error('no electron');
                },
            },
            (rt) => expect(rt.getAppUserDataPath()).toBe(rt.getUserDataDir('gurushots-auto-vote-dev')),
        );
    });

    test('mkdir failure without an error code reports the message and reuses an existing cwd/userData', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const rt = loadRuntime();
        const fallback = `${process.cwd()}/userData`;
        fs.existsSync.mockImplementation((p) => p === fallback);
        fs.mkdirSync.mockImplementationOnce(() => {
            throw new Error('read-only fs');
        });

        expect(rt.getAppUserDataPath()).toBe(fallback);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('(read-only fs)'));
        expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });

    test('no usable fs returns the platform path untouched', () => {
        const rt = loadRuntime();
        fs.existsSync.mockImplementation(() => {
            throw new Error('fs shim');
        });
        expect(rt.getAppUserDataPath()).toBe(rt.getUserDataDir('gurushots-auto-vote-dev'));
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
});
