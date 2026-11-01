/**
 * The phone's peer bridge: the generated window.api settles on the host's
 * results, a lost connection answers a spend with "unclear — check before
 * retrying" and every other invoke with a failure, nothing is replayed after
 * a reconnect, the local channels act in the phone, and the hello handshake
 * tells a fellow phone from the desktop.
 */

import { installPeerBridge, LOCAL_CHANNELS, PAGE_VERSION } from '../../src/ts/shells/remote/bridge/peer';
import { PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
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
        setRemoteConnectionState('connecting');
        [host, phone] = TransportStub.pair('host', 'phone');
        installPeerBridge(phone);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
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

    test('a desktop of another version says to update', () => {
        phone.emitJoin('host');
        phone.receiveFromPeer({ t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, host: true }, 'host');
        expect(remoteConnectionState()).toBe('update');
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
