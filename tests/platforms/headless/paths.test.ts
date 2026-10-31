/**
 * The headless family's paths member: the answers runtime.ts gave on the bare
 * service WebView — the OS branch (through the bundle's os shim on the
 * device), the fail-soft body that ensures the resolved directory once, and
 * isPackaged/isSourceCode of a service build. The app name comes through the
 * core app identity; the app-root members throw — the family invents no
 * app-root path.
 */

import { createHeadlessPaths, UserDataUnavailableError } from '../../../src/ts/platforms/headless/paths';
import { installHeadlessTestPlatform } from '../../helpers/platform';
import { invalid } from '../../helpers/invalid';

import type * as node_fsModule from 'node:fs';
import type * as node_osModule from 'node:os';
import type * as appIdentityModule from '../../../src/ts/platform/appIdentity';

const fs = jest.mocked(require('node:fs') as typeof node_fsModule);

const setProp = (obj: object, key: PropertyKey, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(obj, key);
    Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
    return () => Object.defineProperty(obj, key, invalid<PropertyDescriptor>(original));
};

const restorers: (() => unknown)[] = [];
const withProp = (obj: object, key: PropertyKey, value: unknown) => restorers.push(setProp(obj, key, value));

beforeEach(() => {
    fs.existsSync.mockReset();
    fs.mkdirSync.mockReset();
});

afterEach(() => {
    while (restorers.length) restorers.pop()!();
});

describe('getUserDataDir', () => {
    const os = require('node:os') as typeof node_osModule;

    test('other platforms use ~/.config — the bundle-shim branch the service takes', () => {
        withProp(process, 'platform', 'linux');
        expect(createHeadlessPaths().getUserDataDir('app')).toBe(`${os.homedir()}/.config/app`);
    });

    test('macOS and Windows keep the OS branches of the moved body', () => {
        withProp(process, 'platform', 'darwin');
        expect(createHeadlessPaths().getUserDataDir('app')).toBe(`${os.homedir()}/Library/Application Support/app`);
        withProp(process, 'platform', 'win32');
        process.env.APPDATA = 'C:/Users/u/AppData/Roaming';
        expect(createHeadlessPaths().getUserDataDir('app')).toBe('C:/Users/u/AppData/Roaming/app');
        delete process.env.APPDATA;
        expect(createHeadlessPaths().getUserDataDir('app')).toBe(`${os.homedir()}/AppData/Roaming/app`);
    });
});

describe('userData (the fail-soft body)', () => {
    test('resolves the platform dir for the dev app name and ensures it exists owner-only', () => {
        installHeadlessTestPlatform();
        const os = require('node:os') as typeof node_osModule;
        const paths = createHeadlessPaths();
        fs.existsSync.mockReturnValue(false);
        // The default branch is the one the service's process stub takes.
        withProp(process, 'platform', 'linux');

        const result = paths.userData();
        const { getAppName } = require('../../../src/ts/platform/appIdentity') as typeof appIdentityModule;

        expect(result).toBe(`${os.homedir()}/.config/${getAppName()}`);
        expect(fs.mkdirSync).toHaveBeenCalledWith(result, { recursive: true, mode: 0o700 });
    });

    test('skips mkdir when the directory already exists', () => {
        fs.existsSync.mockReturnValue(true);
        createHeadlessPaths().userData();
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('fails closed with a typed error when the directory cannot be created', () => {
        const paths = createHeadlessPaths();
        fs.existsSync.mockReturnValue(false);
        fs.mkdirSync.mockImplementation(() => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        });
        const expected = paths.getUserDataDir('gurushots-auto-vote-dev');

        let thrown: unknown;
        try {
            paths.userData();
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(UserDataUnavailableError);
        const failure = thrown as InstanceType<typeof UserDataUnavailableError>;
        expect(failure.path).toBe(expected);
        expect(failure.message).toContain(expected);
        expect(failure.message).toContain('EACCES');

        // A failure with no code reports the message.
        fs.mkdirSync.mockImplementationOnce(() => {
            throw new Error('read-only fs');
        });
        expect(() => paths.userData()).toThrow(/read-only fs/);
    });

    test('no usable fs returns the platform path untouched (writers fail-soft)', () => {
        const paths = createHeadlessPaths();
        fs.existsSync.mockImplementation(() => {
            throw new Error('fs shim');
        });
        expect(paths.userData()).toBe(paths.getUserDataDir('gurushots-auto-vote-dev'));
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
});

describe('the service answers', () => {
    test('isPackaged is false and isSourceCode is true', () => {
        const paths = createHeadlessPaths();
        expect(paths.isPackaged()).toBe(false);
        expect(paths.isSourceCode()).toBe(true);
    });
});

describe('the app-root members', () => {
    test('resourcesPath and appPath throw: no service code resolves a path below an app root', () => {
        const paths = createHeadlessPaths();
        expect(() => paths.resourcesPath()).toThrow('headless has no app-root path');
        expect(() => paths.appPath('vision-model')).toThrow('headless has no app-root path');
    });
});
