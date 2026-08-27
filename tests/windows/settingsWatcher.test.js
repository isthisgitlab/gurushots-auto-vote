/**
 * Tests for the settings-file watcher's optional `onSettingsChanged`
 * side-channel (src/js/windows/settingsWatcher.js).
 *
 * The main process learns that auto-vote started or stopped by watching the
 * `autovoteRunning` flag the renderer persists — there is no dedicated IPC
 * channel for it. That makes this hook load-bearing for the power-save blocker
 * in windows/backgroundActivity.js, so it must fire on every successful load
 * (whichever branch follows) and must never be able to cost the window its
 * reload or the renderers their broadcast.
 */

const mockWatchHandlers = [];

jest.mock('node:fs', () => ({
    existsSync: jest.fn(() => true),
    watch: jest.fn((_path, handler) => {
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

jest.mock('../../src/js/settings', () => ({
    getSettingsPath: jest.fn(() => '/tmp/settings.json'),
    loadSettings: jest.fn(),
    isReloadRequired: jest.fn(() => false),
}));

jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    })),
}));

const settings = require('../../src/js/settings');
const { watchSettingsFile } = require('../../src/js/windows/settingsWatcher');

// Window state accessors: an old creation time so the "recently created" guard
// (which deliberately skips the whole change handler) never fires here.
const makeDeps = (onSettingsChanged) => ({
    getMainWindow: () => ({ isDestroyed: () => false, reload: jest.fn() }),
    getMainWindowCreatedTime: () => Date.now() - 60_000,
    onSettingsChanged,
});

// Drive one debounced change event through the watcher.
const emitChange = async () => {
    mockWatchHandlers.at(-1)('change');
    jest.advanceTimersByTime(500);
    await Promise.resolve();
};

describe('watchSettingsFile onSettingsChanged', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockWatchHandlers.length = 0;
        settings.loadSettings.mockReturnValue({ autovoteRunning: false });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('fires with the fresh snapshot when a watched setting changes', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue({ autovoteRunning: true });
        await emitChange();

        expect(onSettingsChanged).toHaveBeenCalledTimes(1);
        expect(onSettingsChanged).toHaveBeenCalledWith({ autovoteRunning: true });
    });

    test('still broadcasts to renderers after the observer runs', async () => {
        watchSettingsFile(makeDeps(jest.fn()));

        settings.loadSettings.mockReturnValue({ autovoteRunning: true });
        await emitChange();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { autovoteRunning: true });
    });

    test('a throwing observer does not stop the broadcast', async () => {
        const onSettingsChanged = jest.fn(() => {
            throw new Error('blocker exploded');
        });
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue({ autovoteRunning: true });
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
            getMainWindow: () => ({ isDestroyed: () => false, reload: jest.fn() }),
            getMainWindowCreatedTime: () => Date.now() - 60_000,
        });

        settings.loadSettings.mockReturnValue({ autovoteRunning: true });
        await expect(emitChange()).resolves.toBeUndefined();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { autovoteRunning: true });
    });

    test('returns null (and never watches) when there is no settings file yet', () => {
        require('node:fs').existsSync.mockReturnValueOnce(false);

        expect(watchSettingsFile(makeDeps(jest.fn()))).toBeNull();
    });

    // The "recently created" guard exists to suppress a RELOAD during login.
    // It must not also suppress the observer: someone who hits Start within
    // two seconds of the window appearing still has to sync the main-process
    // state that tracks the flag, or it stays wrong until an unrelated write
    // happens to fix it — the same class of silent failure this whole branch
    // is about.
    describe('"window recently created" guard', () => {
        const makeYoungWindowDeps = (onSettingsChanged) => ({
            getMainWindow: () => ({ isDestroyed: () => false, reload: jest.fn() }),
            getMainWindowCreatedTime: () => Date.now() - 100,
            onSettingsChanged,
        });

        test('still fires the observer even though it skips the reload', async () => {
            const onSettingsChanged = jest.fn();
            watchSettingsFile(makeYoungWindowDeps(onSettingsChanged));

            settings.loadSettings.mockReturnValue({ autovoteRunning: true });
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
