/**
 * The phone's peer bridge: the generated window.api settles on the host's
 * results, a lost connection answers a spend with "unclear — check before
 * retrying" and every other invoke with a failure, nothing is replayed after
 * a reconnect, the local channels act in the phone, and the hello handshake
 * tells a fellow phone from the desktop.
 */

import { installPeerBridge, LOCAL_CHANNELS } from '../../src/ts/shells/remote/bridge/peer';
import { HELLO_RETRY_MS, HOST_ANSWER_TIMEOUT_MS } from '../../src/ts/core/remote/helloRepeat';
import {
    APP_VERSION,
    LINK_VERSION,
    PROTOCOL_VERSION,
    REMOTE_RESULT_TOO_LARGE,
    REMOTE_RESULT_UNSENDABLE,
} from '../../src/ts/core/remote/protocol';
import { REMOTE_SAY_HELLO_FIRST } from '../../src/ts/core/remote/dispatch';
import { TransportStub } from '../helpers/remoteTransport';
import {
    remoteConnectionState,
    remoteHostPath,
    remoteHostPeerId,
    setRemoteConnectionState,
    setRemoteHostPath,
    setRemoteHostPeerId,
} from '../../src/ts/core/remote/connectionState';

// What the page keeps for the loader's next visit is the store module's (the real one has its own tests, and the
// round trips run in remotePathSkip.test.tsx): here a stand-in records what the bridge asks of it, in order.
const versionCalls: string[] = [];
/** Makes the store's write fail, the way a browser that refuses storage does. */
let storeFails = false;
jest.mock('../../src/ts/core/remote/linkVersion', () => ({
    storeLinkVersion: jest.fn(async (linkVersion: number) => {
        versionCalls.push(`store:${linkVersion}`);
        if (storeFails) throw new Error('storage refused');
    }),
    clearSkipMark: jest.fn(() => {
        versionCalls.push('clearSkipMark');
    }),
}));

const hostHello = {
    t: 'hello',
    version: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    linkVersion: LINK_VERSION,
    host: true,
};
const fellowHello = { t: 'hello', version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, host: false };

// The page hands the bridge the loader it must go to on a version mismatch; the harness gives it one fixed target.
const LOADER_TARGET = 'https://site.test/remote/index.html#k=the-key';

// The bridge listens for the page lifecycle; the node test environment has no window, so a stub takes
// the listeners and the tests fire them.
type PageEvent = { persisted: boolean };
let pageListeners: Map<string, Array<(event: PageEvent) => void>>;
const firePage = (type: 'pagehide' | 'pageshow', persisted: boolean): void => {
    for (const handler of pageListeners.get(type) ?? []) handler({ persisted });
};
beforeEach(() => {
    versionCalls.length = 0;
    storeFails = false;
    pageListeners = new Map();
    Object.defineProperty(globalThis, 'addEventListener', {
        configurable: true,
        writable: true,
        value: (type: string, handler: (event: PageEvent) => void) => {
            pageListeners.set(type, [...(pageListeners.get(type) ?? []), handler]);
        },
    });
});
afterEach(() => {
    delete (globalThis as { addEventListener?: unknown }).addEventListener;
    setRemoteHostPath('direct');
});

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
        installPeerBridge(phone, LOADER_TARGET);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const connect = (): void => {
        phone.emitJoin('host');
        host.receiveFromPeer({ t: 'hello', version: APP_VERSION, host: false }, 'phone');
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

    test('a lost bye: the desktop answering "say hello first" settles a spend in flight as unclear, and asks to be taken back', async () => {
        connect();
        const spend = api.keyUnlockBoost('c1', true) as Promise<unknown>;
        const other = api.getSettings() as Promise<unknown>;
        const spendSent = phone.sent.find(
            ({ message }) => (message as { channel?: string }).channel === 'key-unlock-boost',
        );
        const spendId = (spendSent?.message as { id: number } | undefined)?.id;
        phone.sent.length = 0;
        // The host forgot this phone (its bye was lost) and refuses the spend with the hello-first text.
        phone.receiveFromPeer({ t: 'result', id: spendId, ok: false, error: REMOTE_SAY_HELLO_FIRST }, 'host');
        const answer = (await spend) as { success: boolean; error: string };
        expect(answer.success).toBe(false);
        expect(answer.error).toContain('before retrying'); // unclear, not "This is done on the computer"
        await expect(other).rejects.toThrow(/dropped/);
        expect(remoteConnectionState()).toBe('connecting');
        // The phone asks to be taken back, and the hello repeats until the desktop answers.
        expect(
            phone.sent.filter(({ message }) => (message as { t: string }).t === 'hello').map((s) => s.target),
        ).toEqual(['host']);
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(phone.sent.filter(({ message }) => (message as { t: string }).t === 'hello')).toHaveLength(2);
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS * 2);
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a "say hello first" result, or any result, for an invoke that is not pending is ignored: no reconnect, the others stay pending', async () => {
        connect();
        const waiting = api.getSettings() as Promise<unknown>;
        let settled = false;
        void waiting.then(
            () => (settled = true),
            () => (settled = true),
        );
        phone.sent.length = 0;
        phone.receiveFromPeer({ t: 'result', id: 9_999, ok: false, error: REMOTE_SAY_HELLO_FIRST }, 'host');
        phone.receiveFromPeer({ t: 'result', id: 9_999, ok: true, result: 'late copy' }, 'host');
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(remoteConnectionState()).toBe('connected');
        expect(phone.sent.filter(({ message }) => (message as { t: string }).t === 'hello')).toEqual([]);
    });

    test('a normal refusal settles only its own invoke: the others stay pending and the page stays connected', async () => {
        connect();
        const refused = api.getSettings() as Promise<unknown>;
        const waiting = api.getSettings() as Promise<unknown>;
        const settled = jest.fn();
        void waiting.then(settled, settled);
        const ids = phone.sent
            .filter(({ message }) => (message as { t: string }).t === 'invoke')
            .map(({ message }) => (message as { id: number }).id);
        phone.sent.length = 0;
        phone.receiveFromPeer({ t: 'result', id: ids[0], ok: false, error: 'Refused remotely: nope.' }, 'host');
        await expect(refused).resolves.toMatchObject({ success: false });
        await flushAsync();
        expect(settled).not.toHaveBeenCalled();
        expect(remoteConnectionState()).toBe('connected');
        // Nothing else happens: no hello is sent again, and no reconnect wait starts.
        expect(phone.sent).toEqual([]);
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await flushAsync();
        expect(phone.sent).toEqual([]);
    });

    test('a non-spend invoke lost on disconnect reports a failure', async () => {
        connect();
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitLeave('host');
        await expect(pending).rejects.toThrow(/dropped/);
        // A leave is not the end: a tab in the background can be dropped and taken back. It reads connecting
        // until the wait runs out.
        expect(remoteConnectionState()).toBe('connecting');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('offline');
    });

    test('a desktop that leaves and returns within the wait reads connecting and then connected, never offline', async () => {
        connect();
        phone.emitLeave('host');
        expect(remoteConnectionState()).toBe('connecting');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS - 1_000);
        expect(remoteConnectionState()).toBe('connecting');
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS * 2);
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a second leave restarts the wait rather than stacking another', () => {
        connect();
        phone.emitLeave('host');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS - 1_000);
        phone.emitJoin('host');
        phone.emitLeave('host');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS - 1_000);
        expect(remoteConnectionState()).toBe('connecting');
        jest.advanceTimersByTime(1_000);
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
        phone.receiveFromPeer({ t: 'hello', version: APP_VERSION, host: false }, 'fellow');
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
        phone.receiveFromPeer({ t: 'hello', version: APP_VERSION, host: false }, 'fellow');
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
        phone.receiveFromPeer({ t: 'hello', version: APP_VERSION, host: false }, 'fellow');
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
        for (const channel of invokeChannels) {
            if (LOCAL_CHANNELS.has(channel)) continue;
            phone.sent.length = 0;
            const send = api[kebabToCamel(channel)] as () => Promise<unknown>;
            const pending = send();
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

    test("the desktop's peer id is published for the remote controller and cleared on a loss", () => {
        connect();
        expect(remoteHostPeerId()).toBe('host');
        phone.emitLeave('host');
        expect(remoteHostPeerId()).toBe(null);
    });

    test('only the desktop hello (host: true) connects; a fellow phone does not', () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(
            { t: 'hello', version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'fellow-phone',
        );
        expect(remoteConnectionState()).toBe('connecting');
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    describe('a desktop of another link version', () => {
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
                    { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
                    'host',
                );
                // The loader target is whatever the page handed the bridge (the page resolves it from
                // its own address); the key already rode in it. The version is kept first, so the loader
                // goes straight to the matching page next.
                await Promise.resolve();
                await Promise.resolve();
                expect(versionCalls).toEqual(['store:2']);
                expect(replaced).toEqual([LOADER_TARGET]);
                expect(remoteConnectionState()).toBe('connecting');
                const after = hostReceived.length;
                jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
                await Promise.resolve();
                expect(hostReceived.length).toBe(after);
            } finally {
                jest.useRealTimers();
            }
        });

        test('a store that refuses the write never strands the tab: it still goes to the loader', async () => {
            storeFails = true;
            phone.emitJoin('host');
            phone.receiveFromPeer(
                { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
                'host',
            );
            await flushAsync();
            expect(versionCalls).toEqual(['store:2']);
            expect(replaced).toEqual([LOADER_TARGET]);
        });

        test('once a desktop is accepted, the same peer announcing another version sends the tab to the loader', async () => {
            phone.emitJoin('host');
            phone.receiveFromPeer(hostHello, 'host');
            versionCalls.length = 0;
            phone.receiveFromPeer(
                { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
                'host',
            );
            await flushAsync();
            expect(versionCalls).toEqual(['store:2']);
            expect(replaced).toEqual([LOADER_TARGET]);
        });

        test('once a desktop is accepted, another peer announcing another version changes nothing', async () => {
            phone.emitJoin('host');
            phone.receiveFromPeer(hostHello, 'host');
            versionCalls.length = 0;
            phone.emitJoin('other');
            phone.receiveFromPeer(
                { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
                'other',
            );
            await flushAsync();
            expect(versionCalls).toEqual([]);
            expect(replaced).toEqual([]);
            expect(remoteConnectionState()).toBe('connected');
        });

        test('a legacy desktop (no link version) sends the tab to the loader and stores nothing', async () => {
            phone.emitJoin('host');
            phone.receiveFromPeer(
                { t: 'hello', version: '1.15.0', protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            await flushAsync();
            expect(versionCalls).toEqual([]);
            expect(replaced).toEqual([LOADER_TARGET]);
            expect(remoteConnectionState()).toBe('connecting');
        });

        test('a desktop with the same app version but another link version is still sent to the loader', async () => {
            phone.emitJoin('host');
            phone.receiveFromPeer({ ...hostHello, linkVersion: LINK_VERSION + 1 }, 'host');
            await flushAsync();
            expect(versionCalls).toEqual([`store:${LINK_VERSION + 1}`]);
            expect(replaced).toEqual([LOADER_TARGET]);
        });

        test('a desktop of another app version and the same link version is accepted', async () => {
            phone.emitJoin('host');
            phone.receiveFromPeer({ ...hostHello, version: '0.0.1' }, 'host');
            await flushAsync();
            expect(replaced).toEqual([]);
            expect(remoteConnectionState()).toBe('connected');
        });
    });

    test("the desktop of this page's link version is kept for the loader's next visit, and the loader's mark is cleared; a second hello keeps nothing again", () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        expect(versionCalls).toEqual([`store:${LINK_VERSION}`, 'clearSkipMark']);
        phone.receiveFromPeer(hostHello, 'host');
        expect(versionCalls).toEqual([`store:${LINK_VERSION}`, 'clearSkipMark']);
    });

    test('a store that refuses the write when the desktop is accepted changes nothing: the phone is connected', async () => {
        storeFails = true;
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        await flushAsync();
        expect(remoteConnectionState()).toBe('connected');
        expect(versionCalls).toEqual([`store:${LINK_VERSION}`, 'clearSkipMark']);
    });

    test("a fellow phone's hello keeps nothing", () => {
        phone.emitJoin('other');
        phone.receiveFromPeer(fellowHello, 'other');
        expect(versionCalls).toEqual([]);
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
        installPeerBridge(phone, LOADER_TARGET);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
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
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        // The fellow phone never joined: trystero reports its failed attempt with its id, and it was
        // never a candidate for the desktop.
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        expect(remoteConnectionState()).toBe('connected');
        phone.receiveFromPeer({ t: 'result', id: invokeId(), ok: true, result: 1 }, 'host');
        await expect(pending).resolves.toBe(1);
    });

    test('a join error for a stranger does not end a connected session, even with a fellow phone around', async () => {
        // The desktop is connected; a fellow phone joins and announces itself as no desktop; then a
        // stranger's join attempt fails. trystero reports the failure with the stranger's id — a peer
        // that never joined was never a candidate, so the session stays up.
        phone.emitJoin('fellow');
        phone.receiveFromPeer(hostHello, 'host');
        phone.receiveFromPeer(fellowHello, 'fellow');
        expect(remoteConnectionState()).toBe('connected');
        const pending = api.getSettings() as Promise<unknown>;
        phone.emitJoinError(SDP_FAILURE, 'stranger');
        expect(remoteConnectionState()).toBe('connected');
        phone.receiveFromPeer({ t: 'result', id: invokeId(), ok: true, result: 1 }, 'host');
        await expect(pending).resolves.toBe(1);
    });

    test("a fellow phone's join error before the desktop answers keeps waiting and keeps announcing", async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        // The fellow phone never joined: trystero reports its failed attempt with its id.
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

    test('a desktop SDP failure with no candidate left before the first connect reads as the connection failing', () => {
        // A second phone is open in the room: it joins and announces itself as no desktop, so it is
        // no candidate. The desktop peer never joins; its join attempt fails instead. With nobody
        // left who could still be the desktop, the page reads the connection as failing.
        phone.emitJoin('fellow');
        phone.receiveFromPeer(fellowHello, 'fellow');
        phone.emitJoinError(SDP_FAILURE, 'host');
        expect(remoteConnectionState()).toBe('network');
    });

    test("an announced fellow phone's SDP failure ends nothing", () => {
        // The fellow announces itself as no desktop, so it leaves the candidate set; its own
        // connection trouble on cellular says nothing about the desktop's reachability, and the
        // wait for the desktop goes on.
        phone.emitJoin('fellow');
        phone.receiveFromPeer(fellowHello, 'fellow');
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        expect(remoteConnectionState()).toBe('connecting');
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

        // And once connected, the desktop's own leave is what ends it (after the wait for a return).
        phone.emitLeave('host');
        expect(remoteConnectionState()).toBe('connecting');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('offline');
    });

    test('a leave before the desktop answered, with nobody left, waits and then reads offline', () => {
        phone.emitJoin('host');
        phone.emitLeave('host');
        expect(remoteConnectionState()).toBe('connecting');
        jest.advanceTimersByTime(HOST_ANSWER_TIMEOUT_MS);
        expect(remoteConnectionState()).toBe('offline');
    });

    test("an announced fellow phone's leave ends nothing; the desktop still connects and resolves the held invoke", async () => {
        phone.emitJoin('fellow');
        const pending = api.getSettings() as Promise<unknown>;
        const settled = jest.fn();
        void pending.then(settled, settled);
        // The fellow announces itself as no desktop: it is out of the candidate set from here on.
        phone.receiveFromPeer(fellowHello, 'fellow');
        phone.emitLeave('fellow');
        await flushAsync();
        // The leave is a fellow phone's, not the desktop's: the wait goes on, the held invoke stays.
        expect(settled).not.toHaveBeenCalled();
        expect(remoteConnectionState()).toBe('connecting');

        // The desktop arrives, the held invoke goes out, and its answer resolves it.
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: 1 },
            'host',
        );
        await expect(pending).resolves.toBe(1);
    });

    test("an announced fellow phone's SDP failure ends nothing; the desktop still connects and resolves the held invoke", async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        phone.emitJoin('fellow');
        const pending = api.getSettings() as Promise<unknown>;
        const settled = jest.fn();
        void pending.then(settled, settled);
        // The fellow announces itself as no desktop: it is out of the candidate set from here on.
        phone.receiveFromPeer(fellowHello, 'fellow');
        phone.emitJoinError(SDP_FAILURE, 'fellow');
        await flushAsync();
        // The failure is a fellow phone's, not the desktop's: the wait goes on, the held invoke stays.
        expect(settled).not.toHaveBeenCalled();
        expect(remoteConnectionState()).toBe('connecting');

        // The announce to the desktop still repeats.
        const before = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(hostReceived.length).toBeGreaterThan(before);

        // The desktop arrives, the held invoke goes out, and its answer resolves it.
        phone.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
        const sent = phone.sent.find(({ message }) => (message as { t: string }).t === 'invoke');
        phone.receiveFromPeer(
            { t: 'result', id: (sent?.message as { id: number } | undefined)?.id, ok: true, result: 1 },
            'host',
        );
        await expect(pending).resolves.toBe(1);
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

    test('a channel this page offers that the desktop refuses says to update the app on the computer', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        // get-active-challenges is on this page's own allowlist, so the desktop refusing it is an older desktop.
        const pending = api.getActiveChallenges() as Promise<unknown>;
        phone.receiveFromPeer(
            {
                t: 'result',
                id: invokeId(),
                ok: false,
                error: 'Refused remotely: The channel is not part of the remote surface.',
            },
            'host',
        );
        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Update the app on your computer to use this.',
        });
    });

    test('an allowed channel with allowed arguments that the desktop refuses still says to update (set-setting with an ordinary key)', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.setSetting('mock', true) as Promise<unknown>;
        phone.receiveFromPeer(
            {
                t: 'result',
                id: invokeId(),
                ok: false,
                error: 'Refused remotely: The channel is not part of the remote surface.',
            },
            'host',
        );
        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Update the app on your computer to use this.',
        });
    });

    test('a refused set-setting of the auto-vote key says it is done on the computer: an update would not help', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.setSetting('autovoteRunning', true) as Promise<unknown>;
        phone.receiveFromPeer(
            {
                t: 'result',
                id: invokeId(),
                ok: false,
                error: 'Refused remotely: The auto-vote switch is not a setting — use the Start and Stop controls.',
            },
            'host',
        );
        await expect(pending).resolves.toEqual({ success: false, error: 'This is done on the computer.' });
    });

    test('a refused save-settings that carries the auto-vote key says it is done on the computer', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.saveSettings({ autovoteRunning: true }) as Promise<unknown>;
        phone.receiveFromPeer(
            {
                t: 'result',
                id: invokeId(),
                ok: false,
                error: 'Refused remotely: The auto-vote switch is not a setting — use the Start and Stop controls.',
            },
            'host',
        );
        await expect(pending).resolves.toEqual({ success: false, error: 'This is done on the computer.' });
    });

    test('a result too large for the phone rejects with its own text', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.getSettings() as Promise<unknown>;
        phone.receiveFromPeer(
            { t: 'result', id: invokeId(), ok: false, error: REMOTE_RESULT_TOO_LARGE, reason: 'too-large' },
            'host',
        );
        await expect(pending).rejects.toThrow(/too large/);
    });

    test('a result too large on a spend channel answers unclear instead of failing', async () => {
        // The invoke already ran on the desktop — only its answer was too big. A retry could spend twice.
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        const pending = api.applyTurbo('c1', 'e1') as Promise<unknown>;
        phone.receiveFromPeer(
            { t: 'result', id: invokeId(), ok: false, error: REMOTE_RESULT_TOO_LARGE, reason: 'too-large' },
            'host',
        );
        await expect(pending).resolves.toEqual({
            success: false,
            error: expect.stringContaining('before retrying'),
        });
    });

    test('an unsendable result rejects with its own text on a read channel and answers unclear on a spend', async () => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        // A read: nothing ran that a retry could repeat, so the failure text is right.
        const pending = api.getSettings() as Promise<unknown>;
        phone.receiveFromPeer(
            { t: 'result', id: invokeId(), ok: false, error: REMOTE_RESULT_UNSENDABLE, reason: 'unsendable' },
            'host',
        );
        await expect(pending).rejects.toThrow("The computer's answer could not be sent. Do this on the computer.");

        // A spend: the desktop may have run it before the answer failed to go out — unclear, never a failure.
        phone.sent.length = 0;
        const spend = api.joinChallenge('c1', true) as Promise<unknown>;
        phone.receiveFromPeer(
            { t: 'result', id: invokeId(), ok: false, error: REMOTE_RESULT_UNSENDABLE, reason: 'unsendable' },
            'host',
        );
        await expect(spend).resolves.toEqual({
            success: false,
            error: expect.stringContaining('before retrying'),
        });
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

    test('a full bye fails a held invoke plainly instead of leaving it pending forever', async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        await Promise.resolve();
        // The invoke was created before the desktop answered: on the full bye it was never sent,
        // so it fails plainly instead of hanging forever.
        const pending = api.getSettings() as Promise<unknown>;
        phone.receiveFromPeer({ t: 'bye', reason: 'full' }, 'host');
        await expect(pending).rejects.toThrow('The connection to your computer dropped.');
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

    test('a full bye from a peer that never joined changes nothing, and the announce keeps repeating', async () => {
        const hostReceived: unknown[] = [];
        host.onMessage((_peerId, raw) => hostReceived.push(raw));
        phone.emitJoin('host');
        await Promise.resolve();
        // Any peer in the room could send this; only a joined candidate (or the known desktop) counts.
        phone.receiveFromPeer({ t: 'bye', reason: 'full' }, 'stranger');
        expect(remoteConnectionState()).toBe('connecting');
        const after = hostReceived.length;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        await Promise.resolve();
        expect(hostReceived.length).toBeGreaterThan(after);
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

describe('installPeerBridge: the relay path, hello again and the page lifecycle', () => {
    let phone: TransportStub;
    const SDP_FAILURE = 'could not connect to peer abc after exchanging SDP; configure TURN servers';
    const helloTo = (target: string): number =>
        phone.sent.filter(({ message, target: to }) => (message as { t: string }).t === 'hello' && to === target)
            .length;

    beforeEach(() => {
        jest.useFakeTimers();
        setRemoteConnectionState('connecting');
        [, phone] = TransportStub.pair('host', 'phone');
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const install = (): void => {
        installPeerBridge(phone, LOADER_TARGET);
    };

    const connect = (): void => {
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
    };

    test('a desktop reached over the relays reads the relay path by the time it reads connected', () => {
        Object.assign(phone, { peerPath: (peerId: string) => (peerId === 'host' ? 'relay' : null) });
        install();
        const paths: string[] = [];
        phone.emitJoin('host');
        phone.receiveFromPeer(hostHello, 'host');
        paths.push(remoteHostPath());
        expect(remoteConnectionState()).toBe('connected');
        expect(paths).toEqual(['relay']);
    });

    test("the desktop moving to WebRTC in place changes the path and settles nothing; another peer's move changes nothing", async () => {
        Object.assign(phone, { peerPath: () => 'relay' });
        install();
        connect();
        expect(remoteHostPath()).toBe('relay');
        const api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
        const pending = api.getSettings() as Promise<unknown>;
        let settled = false;
        void pending.then(
            () => (settled = true),
            () => (settled = true),
        );
        phone.emitPathChange('someone-else', 'direct');
        expect(remoteHostPath()).toBe('relay');
        phone.emitPathChange('host', 'direct');
        expect(remoteHostPath()).toBe('direct');
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a transport that does not name paths is a direct one', () => {
        setRemoteHostPath('relay');
        install();
        connect();
        expect(remoteHostPath()).toBe('direct');
    });

    test('a connection failure reads try Wi-Fi where the relay fallback runs, and update-your-browser where it cannot', () => {
        Object.assign(phone, { relayAvailable: () => true });
        install();
        phone.emitJoinError(SDP_FAILURE, 'host');
        expect(remoteConnectionState()).toBe('network');
    });

    test('a connection failure with no relay fallback in this browser says the browser is too old', () => {
        Object.assign(phone, { relayAvailable: () => false });
        install();
        phone.emitJoinError(SDP_FAILURE, 'host');
        expect(remoteConnectionState()).toBe('old-browser');
        setRemoteConnectionState('connecting');
        phone.emitJoinError('incorrect room password when decrypting offer', 'host');
        expect(remoteConnectionState()).toBe('offline'); // only the connection failure is the browser's
    });

    test('a page that goes away for good leaves the transport; one kept for the back/forward cache does not', () => {
        install();
        firePage('pagehide', true);
        expect(phone.left).toBe(false);
        firePage('pagehide', false);
        expect(phone.left).toBe(true);
    });

    test('a page restored from the back/forward cache says hello to the desktop again', () => {
        install();
        firePage('pageshow', true); // before any desktop has answered: the hello repeat is already running
        expect(helloTo('host')).toBe(0);
        connect();
        const before = helloTo('host');
        firePage('pageshow', false); // an ordinary page show
        expect(helloTo('host')).toBe(before);
        firePage('pageshow', true);
        expect(helloTo('host')).toBe(before + 1);
    });
});
