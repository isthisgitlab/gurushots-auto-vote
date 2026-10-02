/**
 * Tests for the settings-file watcher's optional `onSettingsChanged`
 * side-channel (src/ts/windows/settingsWatcher.ts).
 *
 * The main process learns that auto-vote started or stopped by watching the
 * `autovoteRunning` flag the renderer persists — there is no dedicated IPC
 * channel for it. That makes this hook load-bearing for the power-save blocker
 * in windows/backgroundActivity.ts, so it must fire on every successful load
 * (whichever branch follows) and must never be able to cost the window its
 * reload or the renderers their broadcast.
 */

import { invalid } from '../helpers/invalid';

const mockWatchHandlers: Array<(event: string) => void> = [];

jest.mock('node:fs', () => ({
    existsSync: jest.fn(() => true),
    watch: jest.fn((_path: string, handler: (event: string) => void) => {
        mockWatchHandlers.push(handler);
        return { close: jest.fn() };
    }),
}));

const mockSend = jest.fn();
jest.mock('electron', () => ({
    BrowserWindow: {
        getAllWindows: jest.fn(() => [{ isDestroyed: () => false, webContents: { send: mockSend } }]),
    },
}));

jest.mock('../../src/ts/settings', () => ({
    getSettingsPath: jest.fn(() => '/tmp/settings.json'),
    loadSettings: jest.fn(),
    isReloadRequired: jest.fn(() => false),
}));

type LogArgs = [message: string, data?: unknown];
const mockLog = {
    info: jest.fn<void, LogArgs>(),
    debug: jest.fn<void, LogArgs>(),
    warning: jest.fn<void, LogArgs>(),
    error: jest.fn<void, LogArgs>(),
};
jest.mock('../../src/ts/logger', () => ({
    withCategory: jest.fn(() => mockLog),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as settingsWatcherModule from '../../src/ts/windows/settingsWatcher';
import type * as electronModule from 'electron';
import type * as node_fsModule from 'node:fs';
const { watchSettingsFile } = require('../../src/ts/windows/settingsWatcher') as typeof settingsWatcherModule;

type Deps = Parameters<typeof watchSettingsFile>[0];

// Window state accessors: an old creation time so the "recently created" guard
// (which deliberately skips the whole change handler) never fires here.
const makeDeps = (onSettingsChanged: Deps['onSettingsChanged']): Deps => ({
    getMainWindow: () => invalid({ isDestroyed: () => false, reload: jest.fn() }),
    getMainWindowCreatedTime: () => Date.now() - 60_000,
    onSettingsChanged,
});

// Drive one debounced change event through the watcher.
const emitChange = async () => {
    mockWatchHandlers.at(-1)!('change');
    jest.advanceTimersByTime(500);
    await Promise.resolve();
};

describe('watchSettingsFile onSettingsChanged', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockWatchHandlers.length = 0;
        settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: false }));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('fires with the fresh snapshot when a watched setting changes', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: true }));
        await emitChange();

        expect(onSettingsChanged).toHaveBeenCalledTimes(1);
        expect(onSettingsChanged).toHaveBeenCalledWith({ autovoteRunning: true });
    });

    test('still broadcasts to renderers after the observer runs', async () => {
        watchSettingsFile(makeDeps(jest.fn()));

        settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: true }));
        await emitChange();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { autovoteRunning: true });
    });

    test('a throwing observer does not stop the broadcast', async () => {
        const onSettingsChanged = jest.fn(() => {
            throw new Error('blocker exploded');
        });
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: true }));
        await expect(emitChange()).resolves.toBeUndefined();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { autovoteRunning: true });
    });

    test('an unreadable settings file does not fire the observer (nor blame it)', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockImplementation(() => {
            throw new Error('settings.json unreadable');
        });

        await expect(emitChange()).resolves.toBeUndefined();
        // No snapshot exists, so there is nothing to observe. Re-reading here
        // would just fail again and log the read error as an observer failure,
        // naming the wrong culprit.
        expect(onSettingsChanged).not.toHaveBeenCalled();
    });

    test('omitting the observer changes nothing (pre-existing host shape)', async () => {
        watchSettingsFile({
            getMainWindow: () => invalid({ isDestroyed: () => false, reload: jest.fn() }),
            getMainWindowCreatedTime: () => Date.now() - 60_000,
        });

        settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: true }));
        await expect(emitChange()).resolves.toBeUndefined();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { autovoteRunning: true });
    });

    test('returns null (and never watches) when there is no settings file yet', () => {
        jest.mocked(require('node:fs') as typeof node_fsModule).existsSync.mockReturnValueOnce(false);

        expect(watchSettingsFile(makeDeps(jest.fn()))).toBeNull();
    });

    // The "recently created" guard exists to suppress a RELOAD during login.
    // It must not also suppress the observer: someone who hits Start within
    // two seconds of the window appearing still has to sync the main-process
    // state that tracks the flag, or it stays wrong until an unrelated write
    // happens to fix it — the same class of silent failure this whole branch
    // is about.
    describe('"window recently created" guard', () => {
        const makeYoungWindowDeps = (onSettingsChanged: Deps['onSettingsChanged']): Deps => ({
            getMainWindow: () => invalid({ isDestroyed: () => false, reload: jest.fn() }),
            getMainWindowCreatedTime: () => Date.now() - 100,
            onSettingsChanged,
        });

        test('still fires the observer even though it skips the reload', async () => {
            const onSettingsChanged = jest.fn();
            watchSettingsFile(makeYoungWindowDeps(onSettingsChanged));

            settings.loadSettings.mockReturnValue(invalid({ autovoteRunning: true }));
            await emitChange();

            expect(onSettingsChanged).toHaveBeenCalledWith({ autovoteRunning: true });
            // The guard's actual job is still done: nothing was broadcast and
            // no reload happened.
            expect(mockSend).not.toHaveBeenCalled();
        });

        test('a failed read on that path is swallowed, not thrown', async () => {
            const onSettingsChanged = jest.fn();
            watchSettingsFile(makeYoungWindowDeps(onSettingsChanged));

            settings.loadSettings.mockImplementation(() => {
                throw new Error('settings.json unreadable');
            });

            await expect(emitChange()).resolves.toBeUndefined();
            expect(onSettingsChanged).not.toHaveBeenCalled();
        });
    });
});

describe('watchSettingsFile change detection', () => {
    const { BrowserWindow } = jest.mocked(require('electron') as typeof electronModule);
    const fs = require('node:fs') as typeof node_fsModule;
    let reload: jest.MockedFunction<NonNullable<ReturnType<Deps['getMainWindow']>>['reload']>;
    let windowDestroyed: boolean;

    const deps = (overrides: Partial<Deps> = {}): Deps => ({
        getMainWindow: () => invalid({ isDestroyed: () => windowDestroyed, reload }),
        getMainWindowCreatedTime: () => Date.now() - 60_000,
        ...overrides,
    });
    const infoLines = () => mockLog.info.mock.calls.map(([line]) => line);

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockWatchHandlers.length = 0;
        reload = jest.fn();
        windowDestroyed = false;
        settings.isReloadRequired.mockImplementation(() => false);
    });

    afterEach(() => {
        // clearAllMocks keeps implementations; restore the file-level default
        // so the observer suite's broadcast assertions stay order-independent.
        settings.isReloadRequired.mockImplementation(() => false);
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('watches the facade-owned settings path', () => {
        settings.loadSettings.mockReturnValue(invalid({}));
        watchSettingsFile(deps());
        expect(fs.watch).toHaveBeenCalledWith('/tmp/settings.json', expect.any(Function));
    });

    test('a nested reload-required change reloads the main window and broadcasts to the others only', async () => {
        const mainSend = jest.fn();
        const mainWindow = invalid<electronModule.BrowserWindow>({
            isDestroyed: () => false,
            reload,
            webContents: { send: mainSend },
        });
        BrowserWindow.getAllWindows.mockReturnValueOnce([
            mainWindow,
            invalid({ isDestroyed: () => false, webContents: { send: mockSend } }),
        ]);
        settings.loadSettings.mockReturnValue(invalid({ ui: { theme: 'light' } }));
        settings.isReloadRequired.mockImplementation((key) => key === 'ui');
        watchSettingsFile(deps({ getMainWindow: () => mainWindow }));

        settings.loadSettings.mockReturnValue(invalid({ ui: { theme: 'dark' } }));
        await emitChange();

        expect(settings.isReloadRequired).toHaveBeenCalledWith('ui');
        expect(reload).toHaveBeenCalledTimes(1);
        expect(mainSend).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledWith('settings-changed', { ui: { theme: 'dark' } });
        expect(infoLines()).toEqual([
            '🔄 Reload-required settings changed, reloading main window...',
            '  • ui.theme: light → dark (reload required)',
        ]);
    });

    test('a reload-required change with a destroyed main window falls back to broadcasting to live windows', async () => {
        const deadSend = jest.fn();
        BrowserWindow.getAllWindows.mockReturnValueOnce([
            invalid({ isDestroyed: () => true, webContents: { send: deadSend } }),
            invalid({ isDestroyed: () => false, webContents: { send: mockSend } }),
        ]);
        settings.loadSettings.mockReturnValue(invalid({ language: 'en' }));
        settings.isReloadRequired.mockReturnValue(true);
        windowDestroyed = true;
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(invalid({ language: 'lv' }));
        await emitChange();

        expect(reload).not.toHaveBeenCalled();
        expect(deadSend).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledWith('settings-changed', { language: 'lv' });
    });

    test('logs null, object and array differences using a stable string form', async () => {
        settings.loadSettings.mockReturnValue(invalid({ a: null, b: null, c: { x: 1 }, list: [1], same: 'x' }));
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(
            invalid({ a: 'set', b: null, c: null, list: [1, 2], same: 'x', added: { y: 2 } }),
        );
        await emitChange();

        expect(infoLines()).toEqual([
            '🔄 Settings changed (no reload required):',
            '  • a: null → set',
            '  • c: {"x":1} → null',
            '  • list: [1] → [1,2]',
            '  • added: null → {"y":2}',
        ]);
        expect(reload).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('a write with no property differences neither reloads nor broadcasts', async () => {
        settings.loadSettings.mockReturnValue(invalid({ theme: 'light' }));
        watchSettingsFile(deps());

        await emitChange();

        expect(infoLines()).toEqual(['🔄 Settings file changed (no property differences detected)']);
        expect(reload).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('when the initial snapshot could not be loaded, the first change reloads', async () => {
        settings.loadSettings.mockImplementationOnce(() => {
            throw new Error('EACCES');
        });
        watchSettingsFile(deps());
        expect(mockLog.error).toHaveBeenCalledWith('Failed to load initial settings for comparison:', 'EACCES');

        settings.loadSettings.mockReturnValue(invalid({ theme: 'dark' }));
        await emitChange();

        expect(infoLines()).toEqual(['🔄 Settings file changed, reloading main window...']);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('debounces bursts into one handler run and ignores non-change events', async () => {
        settings.loadSettings.mockReturnValue(invalid({ n: 1 }));
        watchSettingsFile(deps());
        settings.loadSettings.mockClear();

        mockWatchHandlers.at(-1)!('rename');
        jest.advanceTimersByTime(1000);
        expect(settings.loadSettings).not.toHaveBeenCalled();

        settings.loadSettings.mockReturnValue(invalid({ n: 2 }));
        mockWatchHandlers.at(-1)!('change');
        jest.advanceTimersByTime(200);
        await emitChange();

        expect(settings.loadSettings).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('a non-Error observer throw is reported by value', async () => {
        settings.loadSettings.mockReturnValue(invalid({ n: 1 }));
        watchSettingsFile(
            deps({
                onSettingsChanged: () => {
                    throw 'observer said no';
                },
            }),
        );

        settings.loadSettings.mockReturnValue(invalid({ n: 2 }));
        await emitChange();

        expect(mockLog.warning).toHaveBeenCalledWith('Settings observer failed: observer said no');
    });

    test('without an observer the young-window guard does not re-read the file', async () => {
        settings.loadSettings.mockReturnValue(invalid({ n: 1 }));
        watchSettingsFile(deps({ getMainWindowCreatedTime: () => Date.now() - 100 }));
        settings.loadSettings.mockClear();

        await emitChange();

        expect(settings.loadSettings).not.toHaveBeenCalled();
        expect(infoLines()).toEqual(['🔄 Settings file changed, but skipping reload (window recently created)']);
    });
});
