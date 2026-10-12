/**
 * The settings watcher against a real directory: the file is replaced by a rename on
 * every save, which would end a watch on the file itself. The watch is on the
 * directory, filtered by the file's name, so it keeps firing after every atomic write.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');

const mockSend = jest.fn();
jest.mock('electron', () => ({
    BrowserWindow: {
        getAllWindows: jest.fn(() => [{ isDestroyed: () => false, webContents: { send: mockSend } }]),
    },
}));

const mockPaths: { settingsFile: string } = { settingsFile: '' };
const mockLoad = jest.fn();
jest.mock('../../src/ts/settings', () => ({
    getSettingsPath: jest.fn(() => mockPaths.settingsFile),
    loadSettings: mockLoad,
    isReloadRequired: jest.fn(() => false),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as settingsWatcherModule from '../../src/ts/windows/settingsWatcher';
import type * as atomicWriteModule from '../../src/ts/settings/atomicWrite';
import { invalid } from '../helpers/invalid';

const { watchSettingsFile } = require('../../src/ts/windows/settingsWatcher') as typeof settingsWatcherModule;
const { writeAtomicOwnerOnly } = require('../../src/ts/settings/atomicWrite') as typeof atomicWriteModule;

const until = async (condition: () => boolean, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
};

// A sandbox or a host out of watch handles cannot watch a directory (EMFILE, or ENOSPC on Linux's inotify), which Node
// reports as an 'error' event on the watcher some moments after it was made: that is the host, not the watcher, so such a
// start is not a failure of this test. The behaviour with the watch mocked is covered by settingsWatcher.test.ts.
const isHostLimit = (error: unknown) => {
    // Not instanceof Error: the error comes from Node's own realm, outside the test's.
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return code === 'EMFILE' || code === 'ENOSPC';
};

describe('watchSettingsFile over atomic saves (real directory)', () => {
    let root: string;
    let watcher: fs.FSWatcher | null;
    let failure: unknown;

    /** Starts the watcher; false when the host cannot give it a watch (nothing to test then). */
    const start = async (): Promise<boolean> => {
        failure = null;
        try {
            watcher = watchSettingsFile({
                getMainWindow: () => null,
                getMainWindowCreatedTime: () => Date.now() - 60_000,
            });
        } catch (error) {
            failure = error;
        }
        watcher?.on('error', (error) => {
            failure = error;
        });
        // The host's refusal arrives as an event, a moment after the watch was made.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (failure && !isHostLimit(failure)) throw failure;
        return !failure;
    };

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-watch-'));
        mockPaths.settingsFile = path.join(root, 'settings.json');
        fs.writeFileSync(mockPaths.settingsFile, '{"n":0}');
        // Some platforms report a change made just before the watch started: let it pass.
        await new Promise((resolve) => setTimeout(resolve, 400));
        mockSend.mockClear();
        mockLoad.mockReset();
        mockLoad.mockReturnValue(invalid({ n: 0 }));
        watcher = null;
    });

    afterEach(() => {
        watcher?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('keeps firing after every one of several atomic writes', async () => {
        if (!(await start())) return;

        for (const n of [1, 2, 3]) {
            mockLoad.mockReturnValue(invalid({ n }));
            writeAtomicOwnerOnly(mockPaths.settingsFile, JSON.stringify({ n }));
            await until(() => mockSend.mock.calls.length >= n || failure !== null);
            if (failure && isHostLimit(failure)) return;
            expect(mockSend).toHaveBeenCalledTimes(n);
            expect(mockSend).toHaveBeenLastCalledWith('settings-changed', { n, hasToken: false });
        }
    });

    test('is not woken by the other files of the directory', async () => {
        if (!(await start())) return;

        mockLoad.mockReturnValue(invalid({ n: 1 }));
        writeAtomicOwnerOnly(path.join(root, 'metadata.json'), '{}');
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (failure && isHostLimit(failure)) return;

        expect(mockSend).not.toHaveBeenCalled();
    });
});
