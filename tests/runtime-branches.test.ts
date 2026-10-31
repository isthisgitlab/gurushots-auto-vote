/**
 * Branch coverage for the runtime.ts env flags. The platform detection
 * helpers that lived here are gone: the platform families and the shell
 * files carry their own checks now (the node family's Electron read in
 * tests/platforms/node/paths.test.ts, the Capacitor-global guards in the
 * native-service tests, the headless platform in tests/shells/). Platform-
 * specific inputs (process.env) are faked per test.
 */

import type * as runtimeModule from '../src/ts/runtime';

const rt = require('../src/ts/runtime') as typeof runtimeModule;

const envKeys = ['NODE_ENV', 'DEV', 'PROD'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
});

afterEach(() => {
    for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe('env flags', () => {
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
