/**
 * Tests for the settings-file watcher's optional `onSettingsChanged`
 * side-channel (src/ts/windows/settingsWatcher.ts).
 *
 * The main process learns that auto-vote started or stopped by watching the
 * `autovoteRunning` flag the renderer persists — there is no dedicated IPC
 * channel for it. That makes this hook load-bearing for the power-save blocker
 * in windows/backgroundActivity.ts, so it must fire on every successful load
 * (whichever branch follows) and must never be able to cost the renderers
 * their broadcast. No window is ever reloaded: the watcher only broadcasts.
 */

import { invalid } from '../helpers/invalid';
import type { ConfigV2 } from '../../src/ts/types/config';

jest.unmock('path');
jest.unmock('node:path');

const mockWatchHandlers: Array<(event: string, fileName: string | null) => void> = [];

jest.mock('node:fs', () => ({
    existsSync: jest.fn(() => true),
    watch: jest.fn((_path: string, handler: (event: string, fileName: string | null) => void) => {
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
    getSettingsPath: jest.fn(() => '/tmp/config.json'),
    loadSettings: jest.fn(),
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

// The configuration the settings answer: the app preferences and the sign-in state (and any other part under test).
const loaded = (app: object, auth: object = {}, rest: object = {}) =>
    invalid<ConfigV2>({ app, auth: { token: '', ...auth }, ...rest });

const makeDeps = (onSettingsChanged: Deps['onSettingsChanged']): Deps => ({ onSettingsChanged });

// Drive one debounced change event through the watcher.
const emitChange = async () => {
    mockWatchHandlers.at(-1)!('change', 'config.json');
    jest.advanceTimersByTime(500);
    await Promise.resolve();
};

describe('watchSettingsFile onSettingsChanged', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockWatchHandlers.length = 0;
        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: false }));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('fires with the fresh snapshot when a watched setting changes', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }));
        await emitChange();

        expect(onSettingsChanged).toHaveBeenCalledTimes(1);
        expect(onSettingsChanged).toHaveBeenCalledWith(loaded({ autovoteRunning: true }));
    });

    test('still broadcasts to renderers after the observer runs', async () => {
        watchSettingsFile(makeDeps(jest.fn()));

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }));
        await emitChange();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { autovoteRunning: true }, hasToken: false });
    });

    test('broadcasts hasToken instead of the token itself', async () => {
        watchSettingsFile(makeDeps(jest.fn()));

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }, { token: 'secret' }));
        await emitChange();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { autovoteRunning: true }, hasToken: true });
    });

    test('a throwing observer does not stop the broadcast', async () => {
        const onSettingsChanged = jest.fn(() => {
            throw new Error('blocker exploded');
        });
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }));
        await expect(emitChange()).resolves.toBeUndefined();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { autovoteRunning: true }, hasToken: false });
    });

    test('an unreadable settings file does not fire the observer (nor blame it)', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockImplementation(() => {
            throw new Error('config.json unreadable');
        });

        await expect(emitChange()).resolves.toBeUndefined();
        // No snapshot exists, so there is nothing to observe. Re-reading here
        // would just fail again and log the read error as an observer failure,
        // naming the wrong culprit.
        expect(onSettingsChanged).not.toHaveBeenCalled();
    });

    test('omitting the observer changes nothing (pre-existing host shape)', async () => {
        watchSettingsFile({});

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }));
        await expect(emitChange()).resolves.toBeUndefined();

        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { autovoteRunning: true }, hasToken: false });
    });

    test('returns null (and never watches) when there is no settings file yet', () => {
        jest.mocked(require('node:fs') as typeof node_fsModule).existsSync.mockReturnValueOnce(false);

        expect(watchSettingsFile(makeDeps(jest.fn()))).toBeNull();
    });

    test('a change right after window creation fires the observer once and broadcasts', async () => {
        const onSettingsChanged = jest.fn();
        watchSettingsFile(makeDeps(onSettingsChanged));

        settings.loadSettings.mockReturnValue(loaded({ autovoteRunning: true }));
        mockWatchHandlers.at(-1)!('change', 'config.json');
        jest.advanceTimersByTime(500);

        expect(onSettingsChanged).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });
});

describe('watchSettingsFile change detection', () => {
    const { BrowserWindow } = jest.mocked(require('electron') as typeof electronModule);
    const fs = require('node:fs') as typeof node_fsModule;
    const reload = jest.fn();

    const deps = (overrides: Partial<Deps> = {}): Deps => ({ ...overrides });
    const infoLines = () => mockLog.info.mock.calls.map(([line]) => line);

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockWatchHandlers.length = 0;
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('watches the directory of the facade-owned settings path, which a rename-replace save keeps', () => {
        settings.loadSettings.mockReturnValue(loaded({}));
        watchSettingsFile(deps());
        expect(fs.watch).toHaveBeenCalledWith('/tmp', expect.any(Function));
    });

    test('a theme change broadcasts to the main window too and reloads nothing', async () => {
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
        settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }));
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(loaded({ theme: 'dark' }));
        await emitChange();

        expect(reload).not.toHaveBeenCalled();
        expect(mainSend).toHaveBeenCalledWith('settings-changed', { app: { theme: 'dark' }, hasToken: false });
        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { theme: 'dark' }, hasToken: false });
        expect(infoLines()).toEqual(['🔄 Settings changed:', '  • app.theme: light → dark']);
    });

    test('a destroyed window is not sent to', async () => {
        const deadSend = jest.fn();
        BrowserWindow.getAllWindows.mockReturnValueOnce([
            invalid({ isDestroyed: () => true, webContents: { send: deadSend } }),
            invalid({ isDestroyed: () => false, webContents: { send: mockSend } }),
        ]);
        settings.loadSettings.mockReturnValue(loaded({ language: 'en' }));
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(loaded({ language: 'lv' }));
        await emitChange();

        expect(deadSend).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledWith('settings-changed', { app: { language: 'lv' }, hasToken: false });
    });

    test('the broadcast payload carries no auth block', async () => {
        settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }, { token: 'oldABC' }));
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(loaded({ theme: 'dark' }, { token: 'newXYZ' }));
        await emitChange();

        const [, payload] = mockSend.mock.calls[0] as [string, Record<string, unknown>];
        expect(payload).not.toHaveProperty('auth');
        expect(JSON.stringify(payload)).not.toMatch(/oldABC|newXYZ/);
    });

    test('logs null, object and array differences using a stable string form', async () => {
        settings.loadSettings.mockReturnValue(loaded({ a: null, b: null, c: { x: 1 }, list: [1], same: 'x' }));
        watchSettingsFile(deps());

        settings.loadSettings.mockReturnValue(
            loaded({ a: 'set', b: null, c: null, list: [1, 2], same: 'x', added: { y: 2 } }),
        );
        await emitChange();

        expect(infoLines()).toEqual([
            '🔄 Settings changed:',
            '  • app.a: null → set',
            '  • app.c: {"x":1} → null',
            '  • app.list: [1] → [1,2]',
            '  • app.added: null → {"y":2}',
        ]);
        expect(reload).not.toHaveBeenCalled();
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    describe('credential values stay out of the log', () => {
        const loggedText = () => infoLines().join('\n');

        test('a changed token is masked on both sides', async () => {
            settings.loadSettings.mockReturnValue(loaded({}, { token: 'oldABC' }));
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(loaded({}, { token: 'newXYZ' }));
            await emitChange();

            expect(infoLines()).toContain('  • auth.token: [REDACTED] → [REDACTED]');
            expect(loggedText()).not.toMatch(/oldABC|newXYZ/);
        });

        test('a newly added apiHeaders object is masked', async () => {
            settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }));
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }, { apiHeaders: { 'x-token': 'newXYZ' } }));
            await emitChange();

            expect(infoLines()).toContain('  • auth.apiHeaders: [REDACTED] → [REDACTED]');
            expect(loggedText()).not.toContain('newXYZ');
        });

        test('a nested apiHeaders value and a nested credential key are masked', async () => {
            settings.loadSettings.mockReturnValue(
                loaded({ network: { password: 'oldPW' } }, { apiHeaders: { 'x-token': 'oldABC', ua: 'oldUA' } }),
            );
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(
                loaded({ network: { password: 'newPW' } }, { apiHeaders: { 'x-token': 'newXYZ', ua: 'newUA' } }),
            );
            await emitChange();

            expect(infoLines()).toEqual([
                '🔄 Settings changed:',
                '  • app.network.password: [REDACTED] → [REDACTED]',
                '  • auth.apiHeaders.x-token: [REDACTED] → [REDACTED]',
                '  • auth.apiHeaders.ua: [REDACTED] → [REDACTED]',
            ]);
            expect(loggedText()).not.toMatch(/oldABC|newXYZ|oldUA|newUA|oldPW|newPW/);
        });
    });

    describe('the account and its chosen photos stay out of the log', () => {
        const loggedText = () => infoLines().join('\n');

        test('a chooser save logs the photo counts, never the ids', async () => {
            settings.loadSettings.mockReturnValue(loaded({ chosenPhotos: ['p-old-1'] }, {}, { challenges: {} }));
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(
                loaded(
                    { chosenPhotos: ['p-old-1', 'p-new-2', 'p-new-3'] },
                    {},
                    { challenges: { 7: { values: { chosenPhotos: ['p-ch-1'] } } } },
                ),
            );
            await emitChange();

            expect(infoLines()).toContain('  • app.chosenPhotos: 1 photo(s) → 3 photo(s)');
            expect(infoLines()).toContain('  • challenges.7: null → {"values":{"chosenPhotos":"1 photo(s)"}}');
            expect(loggedText()).not.toMatch(/p-old|p-new|p-ch/);
        });

        test('a clear logs the counts going to zero', async () => {
            settings.loadSettings.mockReturnValue(
                loaded({}, {}, { challenges: { 7: { values: { chosenPhotos: ['p-ch-1', 'p-ch-2'] } } } }),
            );
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(
                loaded({}, {}, { challenges: { 7: { values: { chosenPhotos: [] } } } }),
            );
            await emitChange();

            expect(infoLines()).toContain('  • challenges.7.values.chosenPhotos: 2 photo(s) → 0 photo(s)');
            expect(loggedText()).not.toContain('p-ch');
        });

        test('a username change and a new chooser owner are masked on both sides', async () => {
            settings.loadSettings.mockReturnValue(
                loaded({}, { lastUsername: 'old@example.com', chosenPhotosMemberId: 'member-old' }),
            );
            watchSettingsFile(deps());

            settings.loadSettings.mockReturnValue(
                loaded({}, { lastUsername: 'new@example.com', chosenPhotosMemberId: 'member-new' }),
            );
            await emitChange();

            expect(infoLines()).toEqual([
                '🔄 Settings changed:',
                '  • auth.lastUsername: [REDACTED] → [REDACTED]',
                '  • auth.chosenPhotosMemberId: [REDACTED] → [REDACTED]',
            ]);
            expect(loggedText()).not.toMatch(/example\.com|member-/);
        });
    });

    test('a write with no property differences does not broadcast', async () => {
        settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }));
        watchSettingsFile(deps());

        await emitChange();

        expect(infoLines()).toEqual(['🔄 Settings file changed (no property differences detected)']);
        expect(reload).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });

    describe('without a baseline (the initial snapshot could not be loaded)', () => {
        const startWithoutBaseline = () => {
            settings.loadSettings.mockImplementationOnce(() => {
                throw new Error('EACCES');
            });
            const onSettingsChanged = jest.fn();
            watchSettingsFile(deps({ onSettingsChanged }));
            expect(mockLog.error).toHaveBeenCalledWith('Failed to load initial settings for comparison:', 'EACCES');
            return onSettingsChanged;
        };

        test('the first good load broadcasts and notifies once, logging no setting value', async () => {
            const onSettingsChanged = startWithoutBaseline();

            settings.loadSettings.mockReturnValue(
                loaded({ theme: 'dark' }, { token: 'secretABC', lastUsername: 'me@example.com' }),
            );
            await emitChange();

            expect(infoLines()).toEqual(['🔄 Settings file changed (no earlier snapshot to compare)']);
            expect(reload).not.toHaveBeenCalled();
            expect(mockSend).toHaveBeenCalledTimes(1);
            expect(onSettingsChanged).toHaveBeenCalledTimes(1);
            expect(JSON.stringify([...mockLog.info.mock.calls, ...mockLog.debug.mock.calls])).not.toMatch(
                /secretABC|me@example\.com|dark/,
            );
        });

        test('the next change diffs against the adopted snapshot and logs one masked bullet', async () => {
            startWithoutBaseline();
            settings.loadSettings.mockReturnValue(loaded({ theme: 'dark' }, { token: 'oldABC' }));
            await emitChange();
            mockLog.info.mockClear();

            settings.loadSettings.mockReturnValue(loaded({ theme: 'dark' }, { token: 'newXYZ' }));
            await emitChange();

            expect(infoLines()).toEqual(['🔄 Settings changed:', '  • auth.token: [REDACTED] → [REDACTED]']);
        });
    });

    test('a failed load sends nothing, skips the observer and keeps the old baseline', async () => {
        settings.loadSettings.mockReturnValue(loaded({ theme: 'light' }));
        const onSettingsChanged = jest.fn();
        watchSettingsFile(deps({ onSettingsChanged }));

        settings.loadSettings.mockImplementation(() => {
            throw new Error('EBUSY');
        });
        await emitChange();

        expect(mockLog.error).toHaveBeenCalledWith('Failed to load new settings for comparison:', 'EBUSY');
        expect(mockSend).not.toHaveBeenCalled();
        expect(onSettingsChanged).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();

        mockLog.info.mockClear();
        settings.loadSettings.mockReturnValue(loaded({ theme: 'dark' }));
        await emitChange();

        expect(infoLines()).toEqual(['🔄 Settings changed:', '  • app.theme: light → dark']);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    });

    test('debounces bursts into one handler run and ignores the other files of the directory', async () => {
        settings.loadSettings.mockReturnValue(loaded({ n: 1 }));
        watchSettingsFile(deps());
        settings.loadSettings.mockClear();

        // A save in progress (its temp file) and the other stores are not the settings.
        mockWatchHandlers.at(-1)!('rename', 'config.json.123.abcd1234.tmp');
        mockWatchHandlers.at(-1)!('change', 'metadata.json');
        jest.advanceTimersByTime(1000);
        expect(settings.loadSettings).not.toHaveBeenCalled();

        settings.loadSettings.mockReturnValue(loaded({ n: 2 }));
        mockWatchHandlers.at(-1)!('change', 'config.json');
        jest.advanceTimersByTime(200);
        await emitChange();

        expect(settings.loadSettings).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // The file is replaced by a rename on every save: the directory reports that as a rename of its name.
    test.each([
        ['a rename of the settings file (the atomic save)', 'rename', 'config.json'],
        ['an event that names no file', 'change', null],
    ] as const)('reacts to %s', async (_name, event, fileName) => {
        settings.loadSettings.mockReturnValue(loaded({ n: 1 }));
        watchSettingsFile(deps());
        settings.loadSettings.mockReturnValue(loaded({ n: 2 }));

        mockWatchHandlers.at(-1)!(event, fileName);
        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('a non-Error observer throw is reported by value', async () => {
        settings.loadSettings.mockReturnValue(loaded({ n: 1 }));
        watchSettingsFile(
            deps({
                onSettingsChanged: () => {
                    throw 'observer said no';
                },
            }),
        );

        settings.loadSettings.mockReturnValue(loaded({ n: 2 }));
        await emitChange();

        expect(mockLog.warning).toHaveBeenCalledWith('Settings observer failed: observer said no');
    });
});
