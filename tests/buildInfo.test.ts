/**
 * isDirtyBuild / displayVersion: whether a build was made outside GitHub Actions. Under Jest the build has no baked-in
 * flag, so each test sets the define the bundlers would inject (a global) or leaves it out, and fakes the environment.
 */

import type * as buildInfoModule from '../src/ts/core/buildInfo';
import type * as appVersionModule from '../src/ts/core/appVersion';
import type * as package_jsonModule from '../package.json';

const { isDirtyBuild } = require('../src/ts/core/buildInfo') as typeof buildInfoModule;
const { displayVersion } = require('../src/ts/core/appVersion') as typeof appVersionModule;
const { version } = require('../package.json') as typeof package_jsonModule;

const envKeys = ['NODE_ENV', 'GITHUB_ACTIONS'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
});

afterEach(() => {
    Reflect.deleteProperty(globalThis, '__GS_DIRTY__');
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

const bakeIn = (value: boolean) => Object.assign(globalThis, { __GS_DIRTY__: value });

describe('isDirtyBuild', () => {
    test.each([true, false])('a baked-in %s wins over an environment that says the opposite', (value) => {
        process.env.NODE_ENV = 'production';
        if (value) process.env.GITHUB_ACTIONS = 'true';
        else delete process.env.GITHUB_ACTIONS;
        bakeIn(value);
        expect(isDirtyBuild()).toBe(value);
    });

    test('without a baked-in flag, GitHub Actions makes a clean build', () => {
        process.env.NODE_ENV = 'production';
        process.env.GITHUB_ACTIONS = 'true';
        expect(isDirtyBuild()).toBe(false);
    });

    test('without a baked-in flag, the test runner makes a clean build', () => {
        process.env.NODE_ENV = 'test';
        delete process.env.GITHUB_ACTIONS;
        expect(isDirtyBuild()).toBe(false);
    });

    test('without a baked-in flag, anything else is dirty', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.GITHUB_ACTIONS;
        expect(isDirtyBuild()).toBe(true);
    });
});

describe('displayVersion', () => {
    test('a dirty build reads x.y.z-dirty, for the package version by default and for any version given', () => {
        bakeIn(true);
        expect(displayVersion()).toBe(`${version}-dirty`);
        expect(displayVersion('2.3.4')).toBe('2.3.4-dirty');
    });

    test('a clean build reads the version as it is', () => {
        bakeIn(false);
        expect(displayVersion()).toBe(version);
        expect(displayVersion('2.3.4')).toBe('2.3.4');
    });
});
