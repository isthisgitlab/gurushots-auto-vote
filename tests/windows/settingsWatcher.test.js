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

const mockLog = { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() };
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => mockLog),
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

describe('watchSettingsFile change detection', () => {
    const { BrowserWindow } = require('electron');
    const fs = require('node:fs');
    let reload;
    let windowDestroyed;

    const deps = (overrides = {}) => ({
        getMainWindow: () => ({ isDestroyed: () => windowDestroyed, reload }),
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
        settings.loadSettings.mockReturnValue({});
        watchSettingsFile(deps());
        expect(fs.watch).toHaveBeenCalledWith('/tmp/settings.json', expect.any(Function));
    });

    test('a nested reload-required change reloads the main window instead of broadcasting', async () => {
        settings.loadSettings.mockReturnValue({ ui: { theme: 'light' } });
        settings.isReloadRequired.mockImplementation((key) => key === 'ui');
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue({ ui: { theme: 'dark' } });
        await emitChange();

        expect(settings.isReloadRequired).toHaveBeenCalledWith('ui');
        expect(reload).toHaveBeenCalledTimes(1);
        expect(mockSend).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            '🔄 Reload-required settings changed, reloading main window...',
            '  • ui.theme: light → dark (reload required)',
        ]);
    });

    test('a reload-required change with a destroyed main window falls back to broadcasting to live windows', async () => {
        const deadSend = jest.fn();
        BrowserWindow.getAllWindows.mockReturnValueOnce([
            { isDestroyed: () => true, webContents: { send: deadSend } },
            { isDestroyed: () => false, webContents: { send: mockSend } },
        ]);
        settings.loadSettings.mockReturnValue({ language: 'en' });
        settings.isReloadRequired.mockReturnValue(true);
        windowDestroyed = true;
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue({ language: 'lv' });
        await emitChange();

        expect(reload).not.toHaveBeenCalled();
        expect(deadSend).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledWith('settings-changed', { language: 'lv' });
    });

    test('logs null, object and array differences using a stable string form', async () => {
        settings.loadSettings.mockReturnValue({ a: null, b: null, c: { x: 1 }, list: [1], same: 'x' });
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue({ a: 'set', b: null, c: null, list: [1, 2], same: 'x', added: { y: 2 } });
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
        settings.loadSettings.mockReturnValue({ theme: 'light' });
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

        settings.loadSettings.mockReturnValue({ theme: 'dark' });
        await emitChange();

        expect(infoLines()).toEqual(['🔄 Settings file changed, reloading main window...']);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('debounces bursts into one handler run and ignores non-change events', async () => {
        settings.loadSettings.mockReturnValue({ n: 1 });
        watchSettingsFile(deps());
        settings.loadSettings.mockClear();

        mockWatchHandlers.at(-1)('rename');
        jest.advanceTimersByTime(1000);
        expect(settings.loadSettings).not.toHaveBeenCalled();

        settings.loadSettings.mockReturnValue({ n: 2 });
        mockWatchHandlers.at(-1)('change');
        jest.advanceTimersByTime(200);
        await emitChange();

        expect(settings.loadSettings).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('a non-Error observer throw is reported by value', async () => {
        settings.loadSettings.mockReturnValue({ n: 1 });
        watchSettingsFile(
            deps({
                onSettingsChanged: () => {
                    throw 'observer said no';
                },
            }),
        );

        settings.loadSettings.mockReturnValue({ n: 2 });
        await emitChange();

        expect(mockLog.warning).toHaveBeenCalledWith('Settings observer failed: observer said no');
    });

    test('without an observer the young-window guard does not re-read the file', async () => {
        settings.loadSettings.mockReturnValue({ n: 1 });
        watchSettingsFile(deps({ getMainWindowCreatedTime: () => Date.now() - 100 }));
        settings.loadSettings.mockClear();

        await emitChange();

        expect(settings.loadSettings).not.toHaveBeenCalled();
        expect(infoLines()).toEqual(['🔄 Settings file changed, but skipping reload (window recently created)']);
    });
});
