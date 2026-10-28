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
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as settingsWatcherModule from '../../src/ts/windows/settingsWatcher';
import type * as atomicWriteModule from '../../src/ts/settings/atomicWrite';
import { canWatchDirectory } from '../helpers/canWatchDirectory';
import { invalid } from '../helpers/invalid';

const { watchSettingsFile } = require('../../src/ts/windows/settingsWatcher') as typeof settingsWatcherModule;
const { writeAtomicOwnerOnly } = require('../../src/ts/settings/atomicWrite') as typeof atomicWriteModule;

const until = async (condition: () => boolean, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
};

// A host that cannot watch a directory (a sandbox, or out of watch handles: EMFILE, or ENOSPC on Linux's inotify, or a watch that never delivers an
// event: a wedged macOS fseventsd) cannot run these tests: they are reported as skipped there, never as passed. On CI the runner must be able to
// watch, so it is an error. The behaviour with the watch mocked is covered by settingsWatcher.test.ts.
const canWatch = canWatchDirectory();
if (!canWatch && process.env.CI) {
    throw new Error(
        'The CI runner must be able to watch a directory (fs.watch failed with EMFILE/ENOSPC, was denied, or never delivered an event).',
    );
}
const maybeTest = canWatch ? test : test.skip;

describe('watchSettingsFile over atomic saves (real directory)', () => {
    let root: string;
    let watcher: fs.FSWatcher | null;
    let failure: unknown;

    /** Starts the watcher; a failure to watch, whenever it is reported, fails the test. */
    const start = async (): Promise<void> => {
        failure = null;
        watcher = watchSettingsFile({});
        watcher?.on('error', (error) => {
            failure = error;
        });
        // The host's refusal arrives as an event, a moment after the watch was made.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (failure) throw failure;
    };

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-watch-'));
        mockPaths.settingsFile = path.join(root, 'config.json');
        fs.writeFileSync(mockPaths.settingsFile, '{"n":0}');
        // Some platforms report a change made just before the watch started: let it pass.
        await new Promise((resolve) => setTimeout(resolve, 400));
        mockSend.mockClear();
        mockLoad.mockReset();
        mockLoad.mockReturnValue(invalid({ app: { n: 0 }, auth: { token: '' } }));
        watcher = null;
    });

    afterEach(() => {
        watcher?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    maybeTest('keeps firing after every one of several atomic writes', async () => {
        expect.assertions(6);
        await start();

        for (const n of [1, 2, 3]) {
            mockLoad.mockReturnValue(invalid({ app: { n }, auth: { token: '' } }));
            writeAtomicOwnerOnly(mockPaths.settingsFile, JSON.stringify({ n }));
            await until(() => mockSend.mock.calls.length >= n || failure !== null);
            if (failure) throw failure;
            expect(mockSend).toHaveBeenCalledTimes(n);
            expect(mockSend).toHaveBeenLastCalledWith('settings-changed', { app: { n }, hasToken: false });
        }
    });

    maybeTest('is not woken by the other files of the directory', async () => {
        expect.assertions(1);
        await start();

        mockLoad.mockReturnValue(invalid({ n: 1 }));
        writeAtomicOwnerOnly(path.join(root, 'metadata.json'), '{}');
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (failure) throw failure;

        expect(mockSend).not.toHaveBeenCalled();
    });
});
