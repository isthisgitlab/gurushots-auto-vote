/**
 * The Android app's remote mode (shells/capacitor/remoteMode.ts): entering from a pasted link
 * stops the background service, clears and flushes the persisted running flag, stores the key
 * and only then moves the WebView to the bundled current remote page; the startup read says whether
 * the app is in remote mode, so a relaunch stays in it.
 */

import { invalid } from '../helpers/invalid';

import type { CapacitorGlobals } from '../../src/ts/core/types/capacitor';

const KEY = 'AbC-_9'.repeat(7) + 'A';
const LINK = `https://example.test/remote/v2/index.html#k=${KEY}`;

const order: string[] = [];
const mockStop = jest.fn<Promise<unknown>, []>();
const mockSettings = {
    setSetting: jest.fn((): boolean => true),
    flushPendingWrites: jest.fn(async () => {}),
};
const mockWarning = jest.fn();

jest.mock('../../src/ts/shells/capacitor/NativeAutovoteBridge', () => ({
    __esModule: true,
    stop: () => mockStop(),
}));
jest.mock('../../src/ts/core/settings', () => ({ __esModule: true, ...mockSettings }));
jest.mock('../../src/ts/core/logger', () => ({
    __esModule: true,
    withCategory: () => ({ warning: mockWarning }),
}));

const g = globalThis as CapacitorGlobals & { location: unknown };
const assign = jest.fn<void, [string]>();

const load = () =>
    require('../../src/ts/shells/capacitor/remoteMode') as typeof import('../../src/ts/shells/capacitor/remoteMode');

describe('Android remote mode', () => {
    let nativePromise: jest.Mock<Promise<unknown>, [string, string, object]>;
    const savedLocation = g.location;

    beforeEach(() => {
        order.length = 0;
        mockStop.mockReset().mockImplementation(async () => {
            order.push('stop');
            return { running: false, available: true };
        });
        mockSettings.setSetting.mockReset().mockImplementation(() => {
            order.push('flag');
            return true;
        });
        mockSettings.flushPendingWrites.mockReset().mockImplementation(async () => {
            order.push('flush');
        });
        mockWarning.mockReset();
        nativePromise = jest.fn<Promise<unknown>, [string, string, object]>(async (_plugin, method) => {
            order.push(method);
            return method === 'get' ? { value: null } : undefined;
        });
        g.Capacitor = { isNativePlatform: () => true, nativePromise };
        assign.mockReset().mockImplementation((url) => void order.push(`go ${url}`));
        g.location = invalid({ assign });
    });

    afterEach(() => {
        delete g.Capacitor;
        g.location = savedLocation;
        jest.resetModules();
    });

    describe('entering from a pasted link', () => {
        test('stops the service, clears and flushes the running flag, stores the key, then loads the bundled current page', async () => {
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: true });
            expect(order).toEqual(['stop', 'flag', 'flush', 'set', `go /remote/v2/index.html#k=${KEY}`]);
            expect(mockSettings.setSetting).toHaveBeenCalledWith('autovoteRunning', false);
            expect(nativePromise).toHaveBeenCalledWith('Preferences', 'set', {
                key: 'gs_remote_access',
                value: `2:${KEY}`,
            });
        });

        test('a build without the native service still enters (nothing runs locally to stop)', async () => {
            mockStop.mockResolvedValue({ running: false, available: false });
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: true });
        });

        test('a link that is not a pairing link changes nothing', async () => {
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode('https://example.test/other/')).resolves.toEqual({
                success: false,
                error: 'bad-link',
            });
            expect(order).toEqual([]);
        });

        test.each([
            `https://example.test/remote/v1/index.html#k=${KEY}`,
            `https://example.test/remote/v3/index.html#k=${KEY}`,
        ])(
            'a non-current link is refused before any service, settings, storage, or navigation side effect',
            async (link) => {
                const { enterRemoteMode } = load();
                await expect(enterRemoteMode(link)).resolves.toEqual({ success: false, error: 'bad-link' });
                expect(order).toEqual([]);
                expect(mockSettings.setSetting).not.toHaveBeenCalled();
                expect(assign).not.toHaveBeenCalled();
            },
        );

        test('a service stop the plugin rejected refuses entering: the service state is unknown', async () => {
            mockStop.mockResolvedValue({ running: false, available: true, error: 'boom' });
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: false, error: 'service-stop' });
            expect(order).toEqual([]);
            expect(assign).not.toHaveBeenCalled();
        });

        test('a message-less stop rejection still refuses (the error key is what counts)', async () => {
            mockStop.mockResolvedValue({ running: false, available: true, error: undefined });
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: false, error: 'service-stop' });
        });

        test('settings that refuse the flag write keep the app in normal mode, with no key stored', async () => {
            mockSettings.setSetting.mockReturnValue(false);
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: false, error: 'settings' });
            expect(nativePromise).not.toHaveBeenCalled();
            expect(assign).not.toHaveBeenCalled();
        });

        test('a flush that fails keeps the app in normal mode, with no key stored', async () => {
            mockSettings.flushPendingWrites.mockRejectedValue(new Error('disk'));
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: false, error: 'settings' });
            expect(nativePromise).not.toHaveBeenCalled();
        });

        test('a key that cannot be stored keeps the app in normal mode', async () => {
            nativePromise.mockRejectedValue(new Error('prefs'));
            const { enterRemoteMode } = load();
            await expect(enterRemoteMode(LINK)).resolves.toEqual({ success: false, error: 'storage' });
            expect(assign).not.toHaveBeenCalled();
        });
    });

    describe('the startup decision', () => {
        test('a stored key keeps the relaunch in remote mode', async () => {
            nativePromise.mockResolvedValue({ value: `2:${KEY}` });
            await expect(load().readStoredPairingKey()).resolves.toBe(KEY);
            expect(mockWarning).not.toHaveBeenCalled();
        });

        test('a non-current stored record starts normal mode and is said in the log', async () => {
            nativePromise.mockResolvedValue({ value: `3:${KEY}` });
            await expect(load().readStoredPairingKey()).resolves.toBeNull();
            expect(mockWarning).toHaveBeenCalledTimes(1);
        });

        test('no stored key starts the normal mode, silently', async () => {
            await expect(load().readStoredPairingKey()).resolves.toBeNull();
            expect(mockWarning).not.toHaveBeenCalled();
        });

        test('a stored value that is not a key starts the normal mode and is said in the log', async () => {
            nativePromise.mockResolvedValue({ value: 'junk' });
            await expect(load().readStoredPairingKey()).resolves.toBeNull();
            expect(mockWarning).toHaveBeenCalledWith(
                'Stored remote-access key could not be read; the app starts in normal mode',
            );
        });

        test('a read the native bridge refused starts the normal mode and is said in the log', async () => {
            nativePromise.mockRejectedValue(new Error('refused'));
            await expect(load().readStoredPairingKey()).resolves.toBeNull();
            expect(mockWarning).toHaveBeenCalledTimes(1);
        });
    });

    test('loadBundledRemotePage moves the WebView to the current page with its key in the fragment', () => {
        load().loadBundledRemotePage(KEY);
        expect(assign).toHaveBeenCalledWith(`/remote/v2/index.html#k=${KEY}`);
    });

    test('installRemoteModeEntry offers the paste entry to the React app', () => {
        const mode =
            require('../../src/ts/core/remote/phoneMode') as typeof import('../../src/ts/core/remote/phoneMode');
        const remoteMode = load();
        remoteMode.installRemoteModeEntry();
        expect(mode.phoneRemoteMode()?.enter).toBe(remoteMode.enterRemoteMode);
    });
});
