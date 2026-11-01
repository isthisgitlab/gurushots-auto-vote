/**
 * The phone's peer bridge: the generated window.api settles on the host's
 * results, a lost connection answers a spend with "unclear — check before
 * retrying" and every other invoke with a failure, nothing is replayed after
 * a reconnect, the local channels act in the phone, and the hello handshake
 * tells a fellow phone from the desktop.
 */

import { installPeerBridge, LOCAL_CHANNELS } from '../../src/ts/shells/remote/bridge/peer';
import { HELLO_RETRY_MS, HOST_ANSWER_TIMEOUT_MS } from '../../src/ts/core/remote/helloRepeat';
import { PAGE_VERSION, PROTOCOL_VERSION, REMOTE_RESULT_TOO_LARGE } from '../../src/ts/core/remote/protocol';
import { TransportStub } from '../helpers/remoteTransport';
import { remoteConnectionState, setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';

const hostHello = { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION, host: true };

const flushAsync = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('installPeerBridge (the phone bridge)', () => {
    let host: TransportStub;
    let phone: TransportStub;
    let api: Record<string, (...args: unknown[]) => unknown>;

    beforeEach(() => {
        // The bridge arms a wait timer when it installs, and the hello repeat is an interval: under fake
        // timers neither outlives the test.
        jest.useFakeTimers();
        setRemoteConnectionState('connecting');
        [host, phone] = TransportStub.pair('host', 'phone');
        installPeerBridge(phone);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const connect = (): void => {
        phone.emitJoin('host');
        host.receiveFromPeer({ t: 'hello', version: PAGE_VERSION, host: false }, 'phone');
        phone.receiveFromPeer(hostHello, 'host');
    };

    test('the bridge marks the remote platform kind synchronously', () => {
        expect((globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind).toBe('remote');
    });

    test('an invoke resolves with the host result', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        expect(sent).toBeDefined();
        expect((sent?.message as { channel: string } | undefined)?.channel).toBe('get-settings');
        const id = (sent?.message as { id: number } | undefined)?.id;
        phone.receiveFromPeer({ t: 'result', id, ok: true, result: { hasToken: true } }, 'host');
        await expect(pending).resolves.toEqual({ hasToken: true });
    });

    test('a result that failed rejects with the host error text', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: false, error: 'no' },
            'host',
        );
        await expect(pending).rejects.toThrow('no');
    });

    test('an invoke made before the connection completes is sent once the desktop says hello', async () => {
        phone.emitJoin('host');
        const pending = api.getSettings() as Promise<unknown>;
        expect(phone.sent.some(({ message }) => (message as { t: string }).t === 'invoke')).toBe(false);
        phone.receiveFromPeer(hostHello, 'host');
        expect(phone.sent.some(({ message }) => (message as { t: string }).t === 'invoke')).toBe(true);
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        const sentId = (sent?.message as { id: number } | undefined)?.id;
        phone.receiveFromPeer({ t: 'result', id: sentId, ok: true, result: 1 }, 'host');
        await expect(pending).resolves.toBe(1);
    });

    test('a lost reply on a spend channel answers unclear, never a plain failure', async () => {
        connect();
        const pending = api.keyUnlockBoost('c1', true) as Promise<unknown>;
        phone.emitLeave('host');
        const answer = (await pending) as { success: boolean; error: string };
        expect(answer.success).toBe(false);
        expect(answer.error).toContain('unknown');
        expect(answer.error).toContain('before retrying');
    });

    test('a non-spend invoke lost on disconnect reports a failure', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitLeave('host');
        await expect(pending).rejects.toThrow(/dropped/);
        expect(remoteConnectionState()).toBe('offline');
    });

    test('in-flight invokes are never replayed after a reconnect', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitLeave('host');
        await expect(pending).rejects.toThrow();
        // The desktop comes back; the bridge says hello again but sends no old invoke.
        phone.sent.length = 0;
        connect();
        expect(phone.sent.every(({ message }) => (message as { t: string }).t === 'hello')).toBe(true);
        const later = api.getSettings() as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        const sentId = (sent?.message as { id: number } | undefined)?.id;
        expect(sentId).toBeDefined();
        phone.receiveFromPeer({ t: 'result', id: sentId, ok: true, result: 2 }, 'host');
        await expect(later).resolves.toBe(2);
    });

    test('a spend whose send itself fails answers unclear too', async () => {
        connect();
        phone.sent.length = 0;
        phone.failNextSendOnce();
        const answer = (await api.joinChallenge('c1', true)) as { success: boolean; error: string };
        expect(answer.success).toBe(false);
        expect(answer.error).toContain('before retrying');
    });

    test('a non-spend send that fails mid-flight reports the failure', async () => {
        connect();
        phone.sent.length = 0;
        phone.failNextSendOnce();
        await expect(api.getSettings()).rejects.toThrow(/dropped/);
        expect(remoteConnectionState()).toBe('connected');
    });

    test('the turbo alias rides its channel, an event reaches its listener, and a non-host hello is ignored', async () => {
        connect();
        // The alias-only method: applyTurbo → apply-turbo-to-entry (a spend).
        const pending = api.applyTurbo('c1', 'e1') as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        expect((sent?.message as { channel: string } | undefined)?.channel).toBe('apply-turbo-to-entry');
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: null },
            'host',
        );
        await expect(pending).resolves.toBeNull();

        // An event method subscribes by channel name and receives the host's payload.
        const seen: unknown[] = [];
        const unsubscribe = api.onLogMessage((payload: unknown) => seen.push(payload)) as () => void;
        phone.receiveFromPeer({ t: 'event', channel: 'log-message', payload: { seq: 1 } }, 'host');
        expect(seen).toEqual([{ seq: 1 }]);
        unsubscribe();

        // A non-host hello while already connected: no state change.
        phone.receiveFromPeer({ t: 'hello', version: PAGE_VERSION, host: false }, 'fellow');
        expect(remoteConnectionState()).toBe('connected');

        // A repeat hello from the already-known desktop changes nothing.
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');

        // An event on a channel nobody subscribes to is dropped.
        phone.receiveFromPeer({ t: 'event', channel: 'update-error', payload: {} }, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a non-host hello while already connected changes nothing, and an undefined argument travels tagged', async () => {
        connect();
        // A fellow phone announcing itself: not the desktop, no state change.
        phone.receiveFromPeer({ t: 'hello', version: PAGE_VERSION, host: false }, 'fellow');
        expect(remoteConnectionState()).toBe('connected');

        // A top-level undefined argument travels as null + its index, and the result resolves.
        const pending = api.setSetting('mock', undefined) as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        expect((sent?.message as { undefinedAt?: number[] } | undefined)?.undefinedAt).toEqual([1]);
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: true },
            'host',
        );
        await expect(pending).resolves.toBe(true);
    });

    test('a malformed message and a result for an unknown id change nothing', () => {
        connect();
        phone.sent.length = 0;
        phone.receiveFromPeer({ t: 'explosion' }, 'host');
        phone.receiveFromPeer({ t: 'result', id: 9999, ok: true, result: 1 }, 'host');
        expect(phone.sent).toHaveLength(0);
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a fellow phone leaving does not read offline', () => {
        connect();
        phone.emitJoin('fellow');
        phone.receiveFromPeer({ t: 'hello', version: PAGE_VERSION, host: false }, 'fellow');
        phone.emitLeave('fellow');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a send that rejects after the invoke was already settled changes nothing', async () => {
        connect();
        phone.failNextSendOnce();
        const pending = api.getSettings() as Promise<unknown>;
        // The bye settles the pending invoke first; the send's rejection lands afterwards.
        phone.receiveFromPeer({ t: 'bye' }, 'host');
        await expect(pending).rejects.toThrow(/dropped/);
        await flushAsync();
        expect(remoteConnectionState()).toBe('offline');
    });

    test('every generated invoke method sends its channel', async () => {
        connect();
        const { invokeChannels, kebabToCamel } =
            require('../../src/ts/core/ipc/manifest') as typeof import('../../src/ts/core/ipc/manifest');
        const methods = api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        for (const channel of invokeChannels) {
            if (LOCAL_CHANNELS.has(channel)) continue;
            phone.sent.length = 0;
            const pending = methods[kebabToCamel(channel)]() as Promise<unknown>;
            const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
            expect((sent?.message as { channel: string } | undefined)?.channel).toBe(channel);
            phone.receiveFromPeer(
                { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: 1 },
                'host',
            );
            await expect(pending).resolves.toBe(1);
        }
    });

    test('a spend issued while the desktop has never said hello fails at once and never sends later', async () => {
        phone.emitJoin('host');
        // Never sent: a plain failure, not the unclear answer of a lost in-flight reply.
        await expect(api.keyUnlockBoost('c1', true)).rejects.toThrow(/dropped/);
        // The desktop arrives: nothing queued fires.
        phone.sent.length = 0;
        phone.receiveFromPeer(hostHello, 'host');
        expect(phone.sent.every(({ message }) => (message as { t: string }).t === 'hello')).toBe(true);
    });

    test('a non-spend issued after a connection loss fails immediately instead of queuing', async () => {
        connect();
        phone.emitLeave('host');
        const pending = api.getSettings() as Promise<unknown>;
        await expect(pending).rejects.toThrow(/dropped/);
        // The desktop comes back: still no queued invoke.
        phone.sent.length = 0;
        connect();
        expect(phone.sent.every(({ message }) => (message as { t: string }).t === 'hello')).toBe(true);
    });

    test('the phone log view pulls its backlog over the bridge through the allowed get-log-backlog', async () => {
        connect();
        const backlog = [
            { seq: 1, level: 'INFO', message: 'first' },
            { seq: 2, level: 'WARN', message: 'second' },
        ];
        const pending = api.getLogBacklog() as Promise<unknown>;
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        expect((sent?.message as { channel: string } | undefined)?.channel).toBe('get-log-backlog');
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: backlog },
            'host',
        );
        await expect(pending).resolves.toEqual(backlog);
    });

    test('the hello repeats until the desktop answers, then stops', async () => {
        jest.useFakeTimers();
        try {
            const hostReceived: unknown[] = [];
            host.onMessage((_peerId, raw) => hostReceived.push(raw));
            // The first announce is dropped on the wire: pushed locally, never delivered.
            phone.failNextSendOnce();
            phone.emitJoin('host');
            await Promise.resolve();
            expect(hostReceived).toHaveLength(0);

            // The retry lands.
            jest.advanceTimersByTime(HELLO_RETRY_MS);
            await Promise.resolve();
            expect(hostReceived.length).toBeGreaterThanOrEqual(1);

            // The desktop answers: the repeat stops.
            phone.receiveFromPeer(hostHello, 'host');
            expect(remoteConnectionState()).toBe('connected');
            const after = hostReceived.length;
            jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
            await Promise.resolve();
            expect(hostReceived.length).toBe(after);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a host bye settles the pending invokes and reads offline', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        phone.receiveFromPeer({ t: 'bye' }, 'host');
        await expect(pending).rejects.toThrow(/dropped/);
        expect(remoteConnectionState()).toBe('offline');
    });

    test('only the desktop hello (host: true) connects; a fellow phone does not', () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(
            { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'fellow-phone',
        );
        expect(remoteConnectionState()).toBe('connecting');
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    describe('a desktop of another version', () => {
        let replaced: string[];
        const realLocation = (globalThis as { location?: unknown }).location;

        beforeEach(() => {
            replaced = [];
            (globalThis as { location?: unknown }).location = {
                hash: '#k=the-key',
                replace: (url: string) => replaced.push(url),
            };
        });

        afterEach(() => {
            (globalThis as { location?: unknown }).location = realLocation;
        });

        test('sends the tab to the stable loader, shows no notice, and the hello repeat stops', async () => {
            jest.useFakeTimers();
            try {
                const hostReceived: unknown[] = [];
                host.onMessage((_peerId, raw) => hostReceived.push(raw));
                phone.emitJoin('host');
                await Promise.resolve();
                phone.receiveFromPeer(
                    { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, host: true },
                    'host',
                );
                // The loader is addressed by file name (the Android app's local server answers a directory path
                // with the app's own document), the key rides in the fragment.
                expect(replaced).toEqual(['../index.html#k=the-key']);
                expect(remoteConnectionState()).toBe('connecting');
                const after = hostReceived.length;
                jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
                await Promise.resolve();
                expect(hostReceived.length).toBe(after);
            } finally {
                jest.useRealTimers();
            }
        });

        test('the same version with another protocol shape says to update the app on the computer', () => {
            phone.emitJoin('host');
            phone.receiveFromPeer(
                { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION + 1, host: true },
                'host',
            );
            expect(replaced).toEqual([]);
            expect(remoteConnectionState()).toBe('update');
        });

        test('without a key to carry, the tab stays where it is', () => {
            (globalThis as { location?: unknown }).location = {
                hash: '',
                replace: (url: string) => replaced.push(url),
            };
            (globalThis as { sessionStorage?: Storage }).sessionStorage?.clear();
            phone.receiveFromPeer(
                { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            expect(replaced).toEqual([]);
        });
    });

    test('a join failure on the SDP exchange says to try Wi-Fi; a wrong password reads as offline', () => {
        phone.emitJoinError('could not connect to peer abc after exchanging SDP; configure TURN servers');
        expect(remoteConnectionState()).toBe('network');
        setRemoteConnectionState('connecting');
        phone.emitJoinError('incorrect room password when decrypting offer');
        expect(remoteConnectionState()).toBe('offline');
    });

    test('events from the host reach the subscribers', () => {
        connect();
        const seen: unknown[] = [];
        const unsubscribe = api.onSettingsChanged((payload: unknown) => seen.push(payload)) as () => void;
        phone.receiveFromPeer({ t: 'event', channel: 'settings-changed', payload: { mock: true } }, 'host');
        expect(seen).toEqual([{ mock: true }]);
        unsubscribe();
        phone.receiveFromPeer({ t: 'event', channel: 'settings-changed', payload: { mock: false } }, 'host');
        expect(seen).toEqual([{ mock: true }]);
    });

    test('the local channels act in the phone and are never sent', async () => {
        connect();
        phone.sent.length = 0;
        const open = globalThis.open;
        const opened: string[] = [];
        (globalThis as { open: unknown }).open = (url: string) => {
            opened.push(url);
            return null;
        };
        const location = (globalThis as { location?: unknown }).location;
        (globalThis as { location?: unknown }).location = { reload: () => undefined };
        try {
            await expect(api.openExternalUrl('https://example.com')).resolves.toEqual({ success: true });
            await expect(api.openExternalUrl('file:///etc/passwd')).resolves.toEqual({
                success: false,
                error: expect.stringContaining('https'),
            });
            await expect(api.reloadWindow()).resolves.toEqual({ success: true });
            await expect(api.refreshMenu()).resolves.toEqual({ success: true });
        } finally {
            (globalThis as { open: unknown }).open = open;
            (globalThis as { location?: unknown }).location = location;
        }
        expect(opened).toEqual(['https://example.com']);
        expect(phone.sent).toHaveLength(0);
    });

    test('logout is refused in the phone: the account lives on the desktop', async () => {
        await expect(api.logout()).rejects.toThrow(/computer/);
        expect(() => api.login()).toThrow(/computer/);
    });
});

describe('installPeerBridge: which peer counts', () => {
    let host: TransportStub;
    let phone: TransportStub;
    let api: Record<string, (...args: unknown[]) => unknown>;
    const SDP_FAILURE = 'could not connect to peer abc after exchanging SDP; configure TURN servers';

    beforeEach(() => {
        jest.useFakeTimers();
        setRemoteConnectionState('connecting');
        [host, phone] = TransportStub.pair('host', 'phone');
        installPeerBridge(phone);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const invokeId = (): number => {
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        return (sent?.message as { id: number } | undefined)?.id ?? -1;
    };

    test('a result, an event and a bye from a fellow phone are ignored', async () => {
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        const id = invokeId();
        const seen: unknown[] = [];
        api.onSettingsChanged((payload: unknown) => seen.push(payload));

        phone.receiveFromPeer({ t: 'result', id, ok: true, result: 'forged' }, 'fellow');
        phone.receiveFromPeer({ t: 'event', channel: 'settings-changed', payload: { forged: true } }, 'fellow');
        phone.receiveFromPeer({ t: 'bye' }, 'fellow');
        expect(seen).toEqual([]);
        expect(remoteConnectionState()).toBe('connected');

        phone.receiveFromPeer({ t: 'result', id, ok: true, result: 'real' }, 'host');
        await expect(pending).resolves.toBe('real');
    });

    test("a fellow phone's join error after the desktop answered keeps the session up", async () => {
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        expect(remoteConnectionState()).toBe('connected');
        phone.receiveFromPeer({ t: 'result', id: invokeId(), ok: true, result: 1 }, 'host');
        await expect(pending).resolves.toBe(1);
    });

    test("the desktop's own join error after it answered ends the session", async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitJoinError(SDP_FAILURE, 'host');
        await expect(pending).rejects.toThrow(/dropped/);
        expect(remoteConnectionState()).toBe('network');
    });

    test("a fellow phone's join error before the desktop answers keeps waiting and keeps announcing", async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        expect(remoteConnectionState()).toBe('connecting');

        // The announce to the desktop still repeats, and its answer still connects.
        const before = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(hostReceived.length).toBeGreaterThan(before);
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('the last pending peer failing before the desktop answers reads as the connection failing', () => {
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        phone.emitJoinError(SDP_FAILURE, 'host');
        expect(remoteConnectionState()).toBe('network');
    });

    test('a fellow phone leaving before the desktop answers keeps waiting; the last peer leaving reads offline', async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        phone.emitLeave('fellow');
        expect(remoteConnectionState()).toBe('connecting');
        const before = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(hostReceived.length).toBeGreaterThan(before);
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');

        // And once connected, the desktop's own leave is what ends it.
        phone.emitLeave('host');
        expect(remoteConnectionState()).toBe('offline');
    });

    test('a leave before the desktop answered, with nobody left, reads offline', () => {
        phone.emitJoin('host');
        phone.emitLeave('host');
        expect(remoteConnectionState()).toBe('offline');
    });

    test('no answer within the wait reads offline, and a desktop that answers later still connects', async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('offline');
        // The repeat keeps running through the offline state.
        const before = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(hostReceived.length).toBeGreaterThan(before);
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('the wait runs out only on a page that is still connecting', () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('connected');
    });

    test("a refused channel resolves as a handler failure in the phone's language, not as the protocol text", async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.wipeLocalData() as Promise<unknown>;
        phone.receiveFromPeer(
            {
                t: 'result',
                id: invokeId(),
                ok: false,
                error: 'Refused remotely: Local data is deleted on the computer.',
            },
            'host',
        );
        await expect(pending).resolves.toEqual({ success: false, error: 'This is done on the computer.' });
    });

    test('a result too large for the phone rejects with its own text', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        phone.receiveFromPeer({ t: 'result', id: invokeId(), ok: false, error: REMOTE_RESULT_TOO_LARGE }, 'host');
        await expect(pending).rejects.toThrow(/too large/);
    });

    test('a desktop that is full says so; it is not an offline computer, and the announce stops', async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        await Promise.resolve();
        phone.receiveFromPeer({ t: 'bye', reason: 'full' }, 'host');
        expect(remoteConnectionState()).toBe('full');
        const after = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
        await Promise.resolve();
        expect(hostReceived.length).toBe(after);
        // The wait running out does not overwrite it.
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('full');
    });

    test('a bye without a reason from a peer that is not the desktop changes nothing', () => {
        phone.emitJoin('host');
        phone.receiveFromPeer({ t: 'bye' }, 'fellow');
        expect(remoteConnectionState()).toBe('connecting');
    });

    test('the log calls end in the phone: answered, never sent to the desktop', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        phone.sent.length = 0;
        for (const method of ['logDebug', 'logWarning', 'logError', 'logApi']) {
            await expect(api[method]('line')).resolves.toEqual({ success: true });
        }
        expect(phone.sent).toHaveLength(0);
        for (const channel of ['log-debug', 'log-warning', 'log-error', 'log-api']) {
            expect(LOCAL_CHANNELS.has(channel)).toBe(true);
        }
    });
});
