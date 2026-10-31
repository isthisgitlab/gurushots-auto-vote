/**
 * The node family's paths member: the OS branches of getUserDataDir, the CLI
 * and Electron resolutions of userData, the packaged-build and source
 * detection, and the app identity the family serves to the core (settings
 * names the app through platform().paths via the appIdentity module).
 * Platform-specific inputs (process.platform, process.versions, the electron /
 * node:sea modules) are faked per test and every module load that depends on
 * them goes through isolateModules — a lazy require inside the callback still
 * resolves there. The one-shot legacy dev-dir notice fires through
 * getSettingsPath in the settings tests (tests/settings/storage-coverage.test.ts),
 * its trigger point.
 */

import { createNodePaths, UserDataUnavailableError } from '../../../src/ts/platforms/node/paths';
import { installTestPlatform, restoreNodeTestPlatform } from '../../helpers/platform';
import { invalid } from '../../helpers/invalid';

import type * as node_fsModule from 'node:fs';
import type * as node_osModule from 'node:os';
import type * as appPathsModule from '../../../src/ts/appPaths';
import type * as appIdentityModule from '../../../src/ts/platform/appIdentity';

const fs = jest.mocked(require('node:fs') as typeof node_fsModule);

jest.mock('../../../src/ts/appPaths', () => ({
    __esModule: true,
    appPath: jest.fn((...segments: string[]) => `/app/${segments.join('/')}`),
}));

const appPaths = jest.mocked(require('../../../src/ts/appPaths') as typeof appPathsModule);

const g = globalThis as typeof globalThis & { Capacitor?: unknown };

const setProp = (obj: object, key: PropertyKey, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(obj, key);
    Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
    return () => Object.defineProperty(obj, key, invalid<PropertyDescriptor>(original));
};

const restorers: (() => unknown)[] = [];
const withProp = (obj: object, key: PropertyKey, value: unknown) => restorers.push(setProp(obj, key, value));

// The family require()s electron / node:sea lazily inside its functions, so
// the assertions must run INSIDE the isolated registry — once isolateModules
// returns, a lazy require would hit (and poison) the shared registry. The
// Electron version flag gates the branch, so the helper sets it like the
// electron mock answers it. The family built there is installed as the
// platform's paths while it runs, so the app identity
// (platform().paths.isSourceCode) answers through it too.
const withNodePaths = (
    { electron, sea }: { electron?: () => unknown; sea?: () => unknown } = {},
    fn: (paths: ReturnType<typeof createNodePaths>) => void,
) => {
    jest.isolateModules(() => {
        if (electron !== undefined) {
            // The version flag is what gates the branch (the family's isElectron).
            (process.versions as { electron?: string }).electron = '43.0.0';
            jest.doMock('electron', electron, { virtual: true });
        }
        if (sea !== undefined) jest.doMock('node:sea', sea, { virtual: true });
        const paths =
            require('../../../src/ts/platforms/node/paths') as typeof import('../../../src/ts/platforms/node/paths');
        const built = paths.createNodePaths();
        installTestPlatform({ paths: built });
        try {
            fn(built);
        } finally {
            restoreNodeTestPlatform();
        }
    });
};

const envKeys = ['NODE_ENV', 'DEV', 'PROD', 'APPDATA'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    jest.clearAllMocks();
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
    appPaths.appPath.mockClear();
});

describe('getUserDataDir', () => {
    const os = require('node:os') as typeof node_osModule;

    test('macOS uses Application Support', () => {
        withProp(process, 'platform', 'darwin');
        expect(createNodePaths().getUserDataDir('app')).toBe(`${os.homedir()}/Library/Application Support/app`);
    });

    test('Windows uses APPDATA, falling back to the roaming profile dir', () => {
        withProp(process, 'platform', 'win32');
        process.env.APPDATA = 'C:/Users/u/AppData/Roaming';
        expect(createNodePaths().getUserDataDir('app')).toBe('C:/Users/u/AppData/Roaming/app');
        delete process.env.APPDATA;
        expect(createNodePaths().getUserDataDir('app')).toBe(`${os.homedir()}/AppData/Roaming/app`);
    });

    test('other platforms use ~/.config', () => {
        withProp(process, 'platform', 'linux');
        expect(createNodePaths().getUserDataDir('app')).toBe(`${os.homedir()}/.config/app`);
    });
});

describe('userData (the app user-data path)', () => {
    beforeEach(() => {
        fs.existsSync.mockReset();
        fs.mkdirSync.mockReset();
    });

    test('CLI branch resolves the platform dir for the dev app name and ensures it exists', () => {
        const paths = createNodePaths();
        fs.existsSync.mockReturnValue(false);

        const result = paths.userData();

        expect(result).toBe(paths.getUserDataDir('gurushots-auto-vote-dev'));
        expect(fs.mkdirSync).toHaveBeenCalledWith(result, { recursive: true, mode: 0o700 });
    });

    test('CLI branch skips mkdir when the directory already exists', () => {
        const paths = createNodePaths();
        fs.existsSync.mockReturnValue(true);

        paths.userData();

        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('CLI branch fails closed with a typed error when the platform dir cannot be created, never using cwd', () => {
        const paths = createNodePaths();
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
        expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
        expect(fs.mkdirSync).not.toHaveBeenCalledWith(`${process.cwd()}/userData`, expect.anything());
    });

    test('mkdir failure without an error code reports the message in the typed error', () => {
        const paths = createNodePaths();
        fs.existsSync.mockReturnValue(false);
        fs.mkdirSync.mockImplementationOnce(() => {
            throw new Error('read-only fs');
        });

        expect(() => paths.userData()).toThrow(UserDataUnavailableError);
        expect(() => {
            fs.mkdirSync.mockImplementationOnce(() => {
                throw new Error('read-only fs');
            });
            paths.userData();
        }).toThrow(/read-only fs/);
        expect(fs.mkdirSync).toHaveBeenCalledTimes(2);
    });

    test('no usable fs returns the platform path untouched', () => {
        const paths = createNodePaths();
        fs.existsSync.mockImplementation(() => {
            throw new Error('fs shim');
        });
        expect(paths.userData()).toBe(paths.getUserDataDir('gurushots-auto-vote-dev'));
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    describe('Electron branch (simulated via process.versions.electron + virtual electron module)', () => {
        test('packaged app: isSourceCode false, plain userData path, no -dev suffix', () => {
            withNodePaths(
                { electron: () => ({ app: { isPackaged: true, getPath: () => '/ud/GuruShotsAutoVote' } }) },
                (paths) => {
                    expect(paths.isSourceCode()).toBe(false);
                    expect(paths.userData()).toBe('/ud/GuruShotsAutoVote');
                },
            );
        });

        test('dev-from-source: -dev appended to the userData basename (canonical dev form)', () => {
            withNodePaths(
                { electron: () => ({ app: { isPackaged: false, getPath: () => '/ud/GuruShotsAutoVote' } }) },
                (paths) => {
                    expect(paths.isSourceCode()).toBe(true);
                    expect(paths.userData()).toBe('/ud/GuruShotsAutoVote-dev');
                },
            );
        });

        test('Electron app without getPath falls back to the CLI resolution', () => {
            fs.existsSync.mockReturnValue(true);
            withNodePaths({ electron: () => ({ app: { isPackaged: false } }) }, (paths) =>
                expect(paths.userData()).toBe(paths.getUserDataDir('gurushots-auto-vote-dev')),
            );
        });

        test('Electron module that throws falls back to the CLI resolution', () => {
            fs.existsSync.mockReturnValue(true);
            withNodePaths(
                {
                    electron: () => {
                        throw new Error('no electron');
                    },
                },
                (paths) => expect(paths.userData()).toBe(paths.getUserDataDir('gurushots-auto-vote-dev')),
            );
        });
    });
});

describe('isSourceCode', () => {
    test('true under Jest (no Electron, no SEA, no asar)', () => {
        expect(createNodePaths().isSourceCode()).toBe(true);
    });

    test('a SEA binary is not source', () => {
        withNodePaths({ sea: () => ({ isSea: () => true }) }, (paths) => expect(paths.isSourceCode()).toBe(false));
    });

    test('Electron without an app object (run-as-node) falls through to source detection', () => {
        withNodePaths({ electron: () => ({}) }, (paths) => expect(paths.isSourceCode()).toBe(true));
    });

    test('Electron module that fails to load is treated as source', () => {
        withNodePaths(
            {
                electron: () => {
                    throw new Error('no electron');
                },
            },
            (paths) => expect(paths.isSourceCode()).toBe(true),
        );
    });
});

describe('isPackaged', () => {
    test('Electron: reads app.isPackaged', () => {
        withNodePaths({ electron: () => ({ app: { isPackaged: true } }) }, (paths) =>
            expect(paths.isPackaged()).toBe(true),
        );
    });

    test('Electron: an unloadable electron module means not packaged', () => {
        withNodePaths(
            {
                electron: () => {
                    throw new Error('no electron');
                },
            },
            (paths) => expect(paths.isPackaged()).toBe(false),
        );
    });

    test('plain Node is never packaged', () => {
        expect(createNodePaths().isPackaged()).toBe(false);
    });
});

describe('isElectronPackaged', () => {
    test('Electron: true only for a packaged app', () => {
        withNodePaths({ electron: () => ({ app: { isPackaged: true } }) }, (paths) =>
            expect(paths.isElectronPackaged()).toBe(true),
        );
        withNodePaths({ electron: () => ({ app: { isPackaged: false } }) }, (paths) =>
            expect(paths.isElectronPackaged()).toBe(false),
        );
    });

    test('plain Node is never the packaged Electron app', () => {
        expect(createNodePaths().isElectronPackaged()).toBe(false);
    });
});

describe('the app identity the family serves', () => {
    test('getAppName carries the -dev suffix when running from source', () => {
        installTestPlatform({ paths: createNodePaths() });
        const { getAppName } = require('../../../src/ts/platform/appIdentity') as typeof appIdentityModule;
        expect(getAppName()).toBe('gurushots-auto-vote-dev');
    });

    test('a packaged build drops the suffix', () => {
        withNodePaths({ electron: () => ({ app: { isPackaged: true, getPath: () => '/ud/App' } }) }, () => {
            const { getAppName } = require('../../../src/ts/platform/appIdentity') as typeof appIdentityModule;
            expect(getAppName()).toBe('gurushots-auto-vote');
        });
    });
});

describe('the app-root members', () => {
    test('resourcesPath answers the Electron resources path on a packaged build', () => {
        (process as { resourcesPath?: string }).resourcesPath = '/res';
        try {
            withNodePaths({ electron: () => ({ app: { isPackaged: true } }) }, (paths) =>
                expect(paths.resourcesPath()).toBe('/res'),
            );
        } finally {
            delete (process as { resourcesPath?: string }).resourcesPath;
        }
    });

    test('resourcesPath answers the app root when running from source', () => {
        expect(createNodePaths().resourcesPath()).toBe('/app/');
        expect(appPaths.appPath).toHaveBeenCalledWith();
    });

    test('appPath delegates to appPaths.appPath', () => {
        expect(createNodePaths().appPath('src', 'assets', 'x')).toBe('/app/src/assets/x');
        expect(appPaths.appPath).toHaveBeenCalledWith('src', 'assets', 'x');
    });
});
