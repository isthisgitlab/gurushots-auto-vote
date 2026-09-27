/**
 * Tests for update.handlers — the auto-updater IPC surface.
 *
 * Lifecycle ownership stays in index.ts, so the handlers receive accessors
 * (getAutoUpdater / setAutoUpdater / getMainWindow). Two contracts matter:
 *   - check-for-updates and clear-skip-version lazily construct the shared
 *     instance and hand it back through setAutoUpdater;
 *   - download/install/skip must NOT construct one — they report
 *     "AutoUpdater not initialized" instead.
 * Every channel returns a {success, ...} envelope and never throws.
 */

import type * as AutoUpdaterModule from '../../src/js/services/AutoUpdater';
import type * as update_handlersModule from '../../src/js/ipc/update.handlers';
import type { IpcMain } from 'electron';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/js/services/AutoUpdater', () => ({ AutoUpdater: jest.fn() }));
jest.mock('../../src/js/services/UpdateChecker', () => ({
    getReleasesUrl: jest.fn(() => 'https://github.com/example/releases'),
}));

const { AutoUpdater } = jest.mocked(require('../../src/js/services/AutoUpdater') as typeof AutoUpdaterModule);
const { buildHandlers, register } = require('../../src/js/ipc/update.handlers') as typeof update_handlersModule;

const makeUpdater = (overrides = {}) => ({
    checkForUpdates: jest.fn().mockResolvedValue({ latestVersion: '9.9.9' }),
    downloadUpdate: jest.fn().mockResolvedValue(undefined),
    quitAndInstall: jest.fn(),
    getUpdateInfo: jest.fn().mockReturnValue({ latestVersion: '9.9.9' }),
    skipVersion: jest.fn(),
    clearSkipVersion: jest.fn(),
    canAutoUpdate: jest.fn().mockReturnValue(true),
    ...overrides,
});

// Accessor pair backed by a local slot, mirroring index.ts.
const makeDeps = (initial: unknown = null) => {
    let current = initial;
    const mainWindow = { id: 'main' };
    return {
        getAutoUpdater: jest.fn(() => current),
        setAutoUpdater: jest.fn((u: unknown) => {
            current = u;
        }),
        getMainWindow: jest.fn(() => mainWindow),
        mainWindow,
    };
};

const NOT_INITIALIZED = { success: false, error: 'AutoUpdater not initialized' };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('check-for-updates', () => {
    test('lazily constructs the updater with the main window and registers it back', async () => {
        const instance = makeUpdater();
        AutoUpdater.mockImplementation(() => invalid(instance));
        const deps = makeDeps(null);
        const handlers = buildHandlers(invalid(deps));

        const result = await handlers['check-for-updates']();

        expect(AutoUpdater).toHaveBeenCalledWith(deps.mainWindow);
        expect(deps.setAutoUpdater).toHaveBeenCalledWith(instance);
        expect(instance.checkForUpdates).toHaveBeenCalledWith(true);
        expect(result).toEqual({ success: true, updateInfo: { latestVersion: '9.9.9' } });
    });

    test('reuses an existing updater without constructing a new one', async () => {
        const existing = makeUpdater();
        const deps = makeDeps(existing);
        await buildHandlers(invalid(deps))['check-for-updates']();
        expect(AutoUpdater).not.toHaveBeenCalled();
        expect(deps.setAutoUpdater).not.toHaveBeenCalled();
        expect(existing.checkForUpdates).toHaveBeenCalledWith(true);
    });

    test('returns the error envelope when the check rejects', async () => {
        const deps = makeDeps(makeUpdater({ checkForUpdates: jest.fn().mockRejectedValue(new Error('offline')) }));
        await expect(buildHandlers(invalid(deps))['check-for-updates']()).resolves.toEqual({
            success: false,
            error: 'offline',
        });
    });
});

describe('download-update', () => {
    test('refuses when no updater exists (does not construct one)', async () => {
        const deps = makeDeps(null);
        await expect(buildHandlers(invalid(deps))['download-update']()).resolves.toEqual(NOT_INITIALIZED);
        expect(AutoUpdater).not.toHaveBeenCalled();
    });

    test('downloads through the existing updater', async () => {
        const updater = makeUpdater();
        await expect(buildHandlers(invalid(makeDeps(updater)))['download-update']()).resolves.toEqual({
            success: true,
        });
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    test('offers the releases page as a fallback when the download fails', async () => {
        const updater = makeUpdater({ downloadUpdate: jest.fn().mockRejectedValue(new Error('net')) });
        await expect(buildHandlers(invalid(makeDeps(updater)))['download-update']()).resolves.toEqual({
            success: false,
            error: 'net',
            fallbackUrl: 'https://github.com/example/releases',
        });
    });
});

describe('install-update', () => {
    test('refuses when no updater exists', async () => {
        await expect(buildHandlers(invalid(makeDeps(null)))['install-update']()).resolves.toEqual(NOT_INITIALIZED);
    });

    test('quits and installs through the existing updater', async () => {
        const updater = makeUpdater();
        await expect(buildHandlers(invalid(makeDeps(updater)))['install-update']()).resolves.toEqual({ success: true });
        expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    test('returns the error envelope when quitAndInstall throws', async () => {
        const updater = makeUpdater({
            quitAndInstall: jest.fn(() => {
                throw new Error('locked');
            }),
        });
        await expect(buildHandlers(invalid(makeDeps(updater)))['install-update']()).resolves.toEqual({
            success: false,
            error: 'locked',
        });
    });
});

describe('skip-update-version', () => {
    test('refuses when no updater exists', async () => {
        await expect(buildHandlers(invalid(makeDeps(null)))['skip-update-version']()).resolves.toEqual(NOT_INITIALIZED);
    });

    test('skips the latest known version', async () => {
        const updater = makeUpdater();
        await expect(buildHandlers(invalid(makeDeps(updater)))['skip-update-version']()).resolves.toEqual({
            success: true,
        });
        expect(updater.skipVersion).toHaveBeenCalledWith('9.9.9');
    });

    test('reports no update info when nothing was checked yet', async () => {
        const updater = makeUpdater({ getUpdateInfo: jest.fn().mockReturnValue(null) });
        await expect(buildHandlers(invalid(makeDeps(updater)))['skip-update-version']()).resolves.toEqual({
            success: false,
            error: 'No update info available',
        });
        expect(updater.skipVersion).not.toHaveBeenCalled();
    });

    test('returns the error envelope when skipVersion throws', async () => {
        const updater = makeUpdater({
            skipVersion: jest.fn(() => {
                throw new Error('disk');
            }),
        });
        await expect(buildHandlers(invalid(makeDeps(updater)))['skip-update-version']()).resolves.toEqual({
            success: false,
            error: 'disk',
        });
    });
});

describe('clear-skip-version', () => {
    test('lazily constructs the updater and clears the skipped version', async () => {
        const instance = makeUpdater();
        AutoUpdater.mockImplementation(() => invalid(instance));
        const deps = makeDeps(null);
        await expect(buildHandlers(invalid(deps))['clear-skip-version']()).resolves.toEqual({ success: true });
        expect(deps.setAutoUpdater).toHaveBeenCalledWith(instance);
        expect(instance.clearSkipVersion).toHaveBeenCalledTimes(1);
    });

    test('returns the error envelope when clearing throws', async () => {
        const updater = makeUpdater({
            clearSkipVersion: jest.fn(() => {
                throw new Error('nope');
            }),
        });
        await expect(buildHandlers(invalid(makeDeps(updater)))['clear-skip-version']()).resolves.toEqual({
            success: false,
            error: 'nope',
        });
    });
});

describe('null rejections — handlers never throw to the renderer', () => {
    test.each([
        ['check-for-updates', 'checkForUpdates', { success: false, error: 'Failed to check for updates' }],
        [
            'download-update',
            'downloadUpdate',
            {
                success: false,
                error: 'Failed to download update',
                fallbackUrl: 'https://github.com/example/releases',
            },
        ],
        ['install-update', 'quitAndInstall', { success: false, error: 'Failed to install update' }],
        ['skip-update-version', 'skipVersion', { success: false, error: 'Failed to skip update version' }],
        ['clear-skip-version', 'clearSkipVersion', { success: false, error: 'Failed to clear skipped version' }],
    ] as const)('%s falls back to a fixed message when the updater throws null', async (channel, method, expected) => {
        const updater = makeUpdater({
            [method]: jest.fn(() => {
                throw null;
            }),
        });
        await expect(buildHandlers(invalid(makeDeps(updater)))[channel]()).resolves.toEqual(expected);
    });
});

describe('get-releases-url and can-auto-update', () => {
    test('get-releases-url returns the releases page', () => {
        expect(buildHandlers(invalid(makeDeps()))['get-releases-url']()).toEqual({
            success: true,
            url: 'https://github.com/example/releases',
        });
    });

    test('can-auto-update reflects the updater capability', () => {
        const updater = makeUpdater({ canAutoUpdate: jest.fn().mockReturnValue(false) });
        expect(buildHandlers(invalid(makeDeps(updater)))['can-auto-update']()).toEqual({
            success: true,
            canAutoUpdate: false,
        });
        expect(updater.canAutoUpdate).toHaveBeenCalled();
    });

    test('can-auto-update reports false without constructing an updater', () => {
        expect(buildHandlers(invalid(makeDeps(null)))['can-auto-update']()).toEqual({
            success: false,
            canAutoUpdate: false,
        });
        expect(AutoUpdater).not.toHaveBeenCalled();
    });
});

describe('register', () => {
    test('registers every channel on ipcMain with the given deps', async () => {
        const channels = new Map<string, Parameters<IpcMain['handle']>[1]>();
        const ipcMain = {
            handle: (channel: string, impl: Parameters<IpcMain['handle']>[1]) => channels.set(channel, impl),
        };
        const updater = makeUpdater();
        register(invalid(ipcMain), invalid(makeDeps(updater)));

        expect([...channels.keys()].sort()).toEqual(Object.keys(buildHandlers(invalid(makeDeps()))).sort());
        await expect(channels.get('install-update')!(invalid(undefined))).resolves.toEqual({ success: true });
        expect(updater.quitAndInstall).toHaveBeenCalled();
    });
});
