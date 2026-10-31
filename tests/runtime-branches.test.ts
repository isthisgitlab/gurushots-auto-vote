/**
 * Branch coverage for runtime.ts platform detection and env flags. The path
 * resolution, app identity and packaged-build bodies that lived here are the
 * platform families' now (tests/platforms/node|webview|headless/paths.test.ts,
 * same assertions); runtime keeps the detection helpers and the env readers.
 * Platform-specific inputs (process.versions, g.Capacitor) are faked per test
 * and every module load that depends on them goes through isolateModules.
 */

import type * as runtimeModule from '../src/ts/runtime';
import { invalid } from './helpers/invalid';

const g = globalThis as typeof globalThis & { Capacitor?: unknown };

const setProp = (obj: object, key: PropertyKey, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(obj, key);
    Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
    return () => Object.defineProperty(obj, key, invalid<PropertyDescriptor>(original));
};

const restorers: (() => unknown)[] = [];
const withProp = (obj: object, key: PropertyKey, value: unknown) => restorers.push(setProp(obj, key, value));

// The assertions that read process.versions / g.Capacitor at module load run
// INSIDE the isolated registry.
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
