/**
 * A phone and the desktop host over the hybrid transport on both sides, with the real relay link (an in-memory
 * relay) and a stub WebRTC path that a test connects or drops when it wants. What the plan promises when a path
 * changes under traffic:
 *
 * - an upgrade (the relay, then WebRTC joining) loses no invoke and duplicates none, and the phone's path follows;
 * - a downgrade (WebRTC drops while an invoke is in flight) settles that invoke, and the phone says hello again and
 *   is served again over the relay;
 * - the relay link giving up on a peer that is on WebRTC now, with relay messages never acknowledged, settles what
 *   was in flight — a spend as unclear.
 */

import { RESEND_MS } from '../../src/ts/core/remote/relayOutbox';
import { createRemoteHost } from '../../src/ts/react/api/remoteHostCreate';
import { createHybridTransport } from '../../src/ts/core/remote/hybridTransport';
import { GAP_HOLD_MS } from '../../src/ts/core/remote/relayInbox';
import { createRelayLink } from '../../src/ts/core/remote/relayLink';
import { installPeerBridge } from '../../src/ts/shells/remote/bridge/peer';
import { initialState } from '../../src/ts/core/autovote/state';
import { APP_VERSION, LINK_VERSION, PROTOCOL_VERSION, isSafeToSendTwice } from '../../src/ts/core/remote/protocol';
import {
    remoteConnectionState,
    remoteHostPath,
    setRemoteConnectionState,
    setRemoteHostPath,
    setRemoteHostPeerId,
} from '../../src/ts/core/remote/connectionState';
import { TransportStub } from '../helpers/remoteTransport';
import { TOPIC, createBus, flush, stubCodec } from '../helpers/relayBus';

import type { Bus } from '../helpers/relayBus';

import type { RemoteTransport } from '../../src/ts/core/remote/relays';

// Keep this suite on the unavailable-storage path without reading Node's getter.
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
});
afterAll(() => {
    if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
});

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** What an invoke came to, watched from the moment it was made so that a rejection is never unhandled. */
type Outcome = { state: 'pending' | 'resolved' | 'rejected'; value?: unknown };
const watch = (promise: unknown): Outcome => {
    const outcome: Outcome = { state: 'pending' };
    (promise as Promise<unknown>).then(
        (value) => Object.assign(outcome, { state: 'resolved', value }),
        (error: unknown) => Object.assign(outcome, { state: 'rejected', value: error }),
    );
    return outcome;
};

// The host and the bridge listen for the page lifecycle; the node test environment has no window, so a stub takes the listeners.
beforeEach(() => {
    for (const name of ['addEventListener', 'removeEventListener']) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: () => undefined });
    }
});
afterEach(() => {
    delete (globalThis as { addEventListener?: unknown }).addEventListener;
    delete (globalThis as { removeEventListener?: unknown }).removeEventListener;
});

describe('a path changing under traffic', () => {
    let hostDirect: TransportStub;
    let phoneDirect: TransportStub;
    let hostHybrid: RemoteTransport;
    let phoneHybrid: RemoteTransport;
    let invoked: Array<{ channel: string; args: unknown[] }>;
    let phoneEvents: string[];
    let hostEvents: string[];
    let bus: Bus;
    let phoneCodec: ReturnType<typeof stubCodec>;
    let hostCodec: ReturnType<typeof stubCodec>;
    /** The handlers the host registered for the events it forwards to the phone, by channel. */
    let forwarded: Map<string, (payload: unknown) => void>;
    let api: Api;

    const run = async (ms: number, step = 100): Promise<void> => {
        for (let at = 0; at < ms; at += step) {
            jest.advanceTimersByTime(step);
            await flush();
        }
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
        setRemoteConnectionState('connecting');
        bus = createBus();
        [hostDirect, phoneDirect] = TransportStub.pair('host', 'phone');
        phoneCodec = stubCodec();
        hostCodec = stubCodec();
        const link = (selfId: string, role: 'host' | 'phone', codec = stubCodec()) =>
            createRelayLink({ io: bus.endpoint(), codec, topic: TOPIC, selfId, role });
        hostHybrid = createHybridTransport({
            direct: hostDirect,
            relay: link('host', 'host', hostCodec),
            role: 'host',
            isSafeDuplicate: isSafeToSendTwice,
        });
        phoneHybrid = createHybridTransport({
            direct: phoneDirect,
            relay: link('phone', 'phone', phoneCodec),
            role: 'phone',
        });
        hostEvents = [];
        hostHybrid.onPeerLeave((peerId) => hostEvents.push(`leave:${peerId}@${Date.now() - 1_700_000_000_000}`));
        phoneEvents = [];
        phoneHybrid.onPeerJoin((peerId) => phoneEvents.push(`join:${peerId}:${phoneHybrid.peerPath?.(peerId)}`));
        phoneHybrid.onPeerLeave((peerId) => phoneEvents.push(`leave:${peerId}`));
        invoked = [];
        forwarded = new Map();
        const host = createRemoteHost({
            createTransport: async () => hostHybrid,
            invoke: async (channel, args) => {
                invoked.push({ channel, args });
                return { echoed: args[0] };
            },
            getAutovoteState: () => initialState,
            runAutovoteCommand: async () => undefined,
            onForwardedEvent: (channel, handler) => {
                forwarded.set(channel, handler);
                return () => forwarded.delete(channel);
            },
            onLogMessage: () => () => undefined,
            notify: () => undefined,
            logInfo: () => undefined,
            version: APP_VERSION,
        });
        await host.start('the-key');
        installPeerBridge(phoneHybrid);
        api = (globalThis as { api?: Api }).api ?? {};
        // The relay alone finds both ends, then the phone says hello and is served.
        await run(1_500);
        expect(remoteConnectionState()).toBe('connected');
        expect(remoteHostPath()).toBe('relay');
        phoneEvents.length = 0;
    });

    afterEach(async () => {
        await Promise.all([hostHybrid.leave(), phoneHybrid.leave()]);
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
        setRemoteHostPath('direct');
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const connectWebRtc = (): void => {
        hostDirect.emitJoin('phone');
        phoneDirect.emitJoin('host');
    };

    test('an upgrade with startup traffic in flight loses no invoke and duplicates none, and nothing leaves', async () => {
        const total = 60;
        const calls = Array.from({ length: total }, (_v, n) => watch(api.getSetting(`key-${n}`)));
        await run(300); // some are on their way over the relay, some are still queued
        connectWebRtc();
        // Traffic made after the upgrade goes over WebRTC.
        const after = Array.from({ length: 10 }, (_v, n) => watch(api.getSetting(`after-${n}`)));
        await run(40_000, 250);
        expect([...calls, ...after]).toEqual([
            ...Array.from({ length: total }, (_v, n) => ({ state: 'resolved', value: { echoed: `key-${n}` } })),
            ...Array.from({ length: 10 }, (_v, n) => ({ state: 'resolved', value: { echoed: `after-${n}` } })),
        ]);
        // Each invoke ran on the desktop exactly once.
        const ran = invoked.filter(({ channel }) => channel === 'get-setting').map(({ args }) => args[0]);
        expect(ran).toHaveLength(total + 10);
        expect(new Set(ran).size).toBe(total + 10);
        expect(phoneEvents).toEqual([]); // no leave, no join
        expect(phoneHybrid.peerPath?.('host')).toBe('direct');
        expect(remoteHostPath()).toBe('direct');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('a downgrade while an invoke is in flight settles it, and the phone is served again over the relay', async () => {
        connectWebRtc();
        await run(500);
        expect(remoteHostPath()).toBe('direct');
        // The invoke leaves over WebRTC; WebRTC drops on both sides before the answer comes back.
        const lost = api.getSetting('lost') as Promise<unknown>;
        const outcome = lost.then(
            () => 'resolved',
            () => 'rejected',
        );
        hostDirect.emitLeave('phone');
        phoneDirect.emitLeave('host');
        await run(100);
        expect(await outcome).toBe('rejected');
        // The relay reaches the peer: leave, then join as relay, then hello again.
        expect(phoneEvents).toEqual(['leave:host', 'join:host:relay']);
        await run(3_000);
        expect(remoteConnectionState()).toBe('connected');
        expect(remoteHostPath()).toBe('relay');
        await expect(api.getSetting('again')).resolves.toEqual({ echoed: 'again' });
    });

    const setSettingCalls = (): unknown[][] =>
        invoked.filter(({ channel }) => channel === 'set-setting').map(({ args }) => args);

    test('the desktop result that was started on the relay at the upgrade reaches the phone over WebRTC when the relays then drop everything', async () => {
        // The desktop's results leave but never arrive: a result started on the relay and not acknowledged.
        bus.filter = (frame) => !(frame.header.kind === 'data' && frame.header.from === 'host');
        const asked = watch(api.getSetting('r'));
        await run(500);
        expect(invoked.filter(({ channel }) => channel === 'get-setting').map(({ args }) => args[0])).toEqual(['r']);
        connectWebRtc();
        bus.filter = () => false; // from here no relay delivers anything
        await run(60_000, 250);
        expect(asked).toEqual({ state: 'resolved', value: { echoed: 'r' } });
        expect(hostEvents).toEqual([]); // the desktop never dropped the phone, though its relay link gave up on the result
        expect(phoneEvents).toEqual([]);
        expect(remoteHostPath()).toBe('direct');
        expect(remoteConnectionState()).toBe('connected');
    });

    test('the relay copy of a result that was copied to WebRTC arrives later and is ignored: nothing reconnects and the next invoke works', async () => {
        bus.filter = (frame) => !(frame.header.kind === 'data' && frame.header.from === 'host');
        const asked = watch(api.getSetting('r'));
        await run(500);
        connectWebRtc();
        await run(200);
        expect(asked).toEqual({ state: 'resolved', value: { echoed: 'r' } }); // the WebRTC copy
        bus.filter = () => true;
        await run(RESEND_MS + 1_000, 250); // the relay copy arrives
        expect(phoneEvents).toEqual([]);
        expect(hostEvents).toEqual([]);
        expect(remoteConnectionState()).toBe('connected');
        await expect(api.getSetting('next')).resolves.toEqual({ echoed: 'next' });
    });

    test('a result started on the relay leaves no gap in the relay stream: a later relay message after a downgrade is not held for the gap timer', async () => {
        bus.filter = (frame) => !(frame.header.kind === 'data' && frame.header.from === 'host');
        const asked = watch(api.getSetting('r'));
        await run(500);
        connectWebRtc();
        await run(200);
        expect(asked.state).toBe('resolved');
        bus.filter = () => true;
        // WebRTC drops: the peer is on the relay again, and the next result travels the relay stream behind the started one.
        hostDirect.emitLeave('phone');
        phoneDirect.emitLeave('host');
        // The desktop's answer to the hello that follows travels the relay stream behind the started result: it is not held for the gap timer.
        await run(GAP_HOLD_MS - 2_000, 250);
        expect(remoteConnectionState()).toBe('connected');
        const next = watch(api.getSetting('after the downgrade'));
        await run(1_000, 250);
        expect(next).toEqual({ state: 'resolved', value: { echoed: 'after the downgrade' } });
        expect(hostEvents).toHaveLength(1); // only the downgrade's own leave
    });

    test('an event that started on the relay at the upgrade is not copied: it finishes on the relay and reaches the phone exactly once', async () => {
        const seen: unknown[] = [];
        // The bridge's subscription answers its unsubscribe function; the loose `Api` type calls it a promise.
        void api.onSettingsChanged((payload: unknown) => seen.push(payload));
        bus.filter = (frame) => !(frame.header.kind === 'data' && frame.header.from === 'host');
        forwarded.get('settings-changed')?.({ mock: true });
        await run(500);
        connectWebRtc();
        await run(200);
        expect(seen).toEqual([]); // not copied over WebRTC
        bus.filter = () => true;
        await run(RESEND_MS + 2_000, 250);
        expect(seen).toEqual([{ mock: true }]);
        await run(20_000, 250);
        expect(seen).toEqual([{ mock: true }]);
    });

    test('two writes to one setting during an upgrade reach the desktop in the order they were made, though the first was started on the relay', async () => {
        // The phone's first write leaves on the relay and is lost there; the link resends it later.
        bus.filter = (frame) => !(frame.header.kind === 'data' && frame.header.from === 'phone');
        const first = watch(api.setSetting('k', 'A'));
        await run(300);
        connectWebRtc();
        const second = watch(api.setSetting('k', 'B'));
        await run(500);
        // The phone waits for the relay to drain before it moves, and the second write waits here, behind the first.
        bus.filter = () => true;
        await run(20_000, 250);
        expect([first.state, second.state]).toEqual(['resolved', 'resolved']);
        expect(setSettingCalls()).toEqual([
            ['k', 'A'],
            ['k', 'B'],
        ]);
        expect(phoneHybrid.peerPath?.('host')).toBe('direct');
        expect(phoneEvents).toEqual([]);
    });

    test('a message still being packed when the upgrade begins, and the sends made after it, reach the desktop in order (real packing across the upgrade)', async () => {
        // X is started on the relay and not acknowledged; M1 is being packed when WebRTC joins; M2 and M3 are sent after.
        bus.filter = (frame) => !(frame.header.kind === 'ack' && frame.header.from === 'host');
        const calls = [watch(api.setSetting('k', 'X'))];
        await run(300);
        const pack = phoneCodec.pack;
        let finishPacking = (): void => undefined;
        phoneCodec.pack = async (message) => {
            await new Promise<void>((resolve) => (finishPacking = resolve));
            return pack(message);
        };
        calls.push(watch(api.setSetting('k', 'M1')));
        await run(100);
        connectWebRtc();
        calls.push(watch(api.setSetting('k', 'M2')), watch(api.setSetting('k', 'M3')));
        await run(300);
        expect(phoneHybrid.peerPath?.('host')).toBe('relay');
        bus.filter = () => true; // X is acknowledged at its next resend; M1 is still being packed
        await run(RESEND_MS + 1_000, 250);
        expect(phoneHybrid.peerPath?.('host')).toBe('relay'); // M1 is in flight
        phoneCodec.pack = pack;
        finishPacking();
        await run(RESEND_MS + 2_000, 250);
        expect(calls.map(({ state }) => state)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
        expect(setSettingCalls()).toEqual([
            ['k', 'X'],
            ['k', 'M1'],
            ['k', 'M2'],
            ['k', 'M3'],
        ]);
        expect(phoneHybrid.peerPath?.('host')).toBe('direct');
    });

    test('WebRTC lost while the phone drains, with the desktop having answered over WebRTC: the invoke settles (a spend as unclear) and the phone says hello again', async () => {
        // The phone's spend reaches the desktop on the relay, but nothing the desktop sends on the relay arrives.
        bus.filter = (frame) => frame.header.from !== 'host';
        const spend = watch(api.keyUnlockBoost('c1', true));
        await run(300);
        expect(invoked.some(({ channel }) => channel === 'key-unlock-boost')).toBe(true); // the desktop has it
        // The desktop upgrades at once and answers over WebRTC; the answer is lost with the connection.
        hostDirect.send = async (message, target) => {
            hostDirect.sent.push({ message, target });
        };
        connectWebRtc();
        expect(hostDirect.sent.some(({ message }) => (message as { t: string }).t === 'result')).toBe(true);
        expect(phoneHybrid.peerPath?.('host')).toBe('relay'); // the phone is still draining
        expect(spend.state).toBe('pending');
        hostDirect.emitLeave('phone');
        phoneDirect.emitLeave('host');
        await run(100);
        expect(spend.state).toBe('resolved');
        expect((spend.value as { error?: string }).error).toContain('before retrying');
        expect(phoneEvents).toEqual(['leave:host', 'join:host:relay']);
        bus.filter = () => true;
        await run(4_000, 250);
        expect(remoteConnectionState()).toBe('connected'); // it said hello again and was taken back
        expect(remoteHostPath()).toBe('relay');
        const again = watch(api.getSetting('again'));
        await run(1_000, 250);
        expect(again).toEqual({ state: 'resolved', value: { echoed: 'again' } });
    });

    /** The desktop's relay link gives up on the phone: an event it sent is never acknowledged, so it is sent again three times and then given up on. */
    const giveUpOnThePhone = async (): Promise<void> => {
        bus.filter = (frame) => !(frame.header.kind === 'ack' && frame.header.from === 'phone');
        forwarded.get('settings-changed')?.({ mock: true });
        await run(300);
    };
    const hostGaveUp = (): boolean =>
        bus.published.some((frame) => frame.header.kind === 'bye' && frame.header.from === 'host');

    test('a desktop result still being packed at an upgrade reaches the phone over WebRTC though the relay link gives up on the phone meanwhile', async () => {
        await giveUpOnThePhone();
        // The phone asks; the desktop's answer is still being packed when WebRTC joins.
        const pack = hostCodec.pack;
        let finishPacking = (): void => undefined;
        hostCodec.pack = async (message) => {
            await new Promise<void>((resolve) => (finishPacking = resolve));
            return pack(message);
        };
        const asked = watch(api.getSetting('r'));
        await run(300);
        expect(invoked.filter(({ channel }) => channel === 'get-setting').map(({ args }) => args[0])).toEqual(['r']);
        connectWebRtc(); // the desktop upgrades: what finishes packing from now on goes over WebRTC
        await run(RESEND_MS * 4 + 1_000, 250);
        expect(hostGaveUp()).toBe(true); // the relay link gave up on the phone, which is no longer one of its peers
        expect(asked.state).toBe('pending');
        hostCodec.pack = pack;
        finishPacking();
        await run(1_000, 250);
        expect(asked).toEqual({ state: 'resolved', value: { echoed: 'r' } });
        expect(hostEvents).toEqual([]); // the desktop never dropped the phone
    });

    test('a redirect does not outlive its peer: after a relay give-up and a WebRTC loss, the same phone joining again over the relay is answered on the relay', async () => {
        await giveUpOnThePhone();
        connectWebRtc();
        await run(RESEND_MS * 4 + 1_000, 250);
        expect(hostGaveUp()).toBe(true);
        // WebRTC is lost on both sides; nothing the desktop sends over it arrives any more.
        hostDirect.send = async (message, target) => {
            hostDirect.sent.push({ message, target });
        };
        hostDirect.sent.length = 0;
        hostDirect.emitLeave('phone');
        phoneDirect.emitLeave('host');
        bus.filter = () => true;
        await run(20_000, 250); // the phone's presence finds the desktop's relay link again, and it says hello
        expect(remoteConnectionState()).toBe('connected');
        expect(remoteHostPath()).toBe('relay');
        const again = watch(api.getSetting('again'));
        await run(1_500, 250);
        expect(again).toEqual({ state: 'resolved', value: { echoed: 'again' } });
        expect(hostDirect.sent.filter(({ message }) => (message as { t: string }).t === 'result')).toEqual([]);
    });

    test('a phone that sends faster than a relay round trip still reaches WebRTC: the drain ends once what was started is acknowledged', async () => {
        // The desktop's acknowledgements take 800 ms to come back, so a send every 50 ms always has messages in flight.
        const sealBatch = hostCodec.sealBatch;
        hostCodec.sealBatch = async (batch) => {
            if (batch.acks.length > 0) await new Promise<void>((resolve) => setTimeout(resolve, 800));
            return sealBatch(batch);
        };
        const calls: Outcome[] = [];
        const joinedAt = 1_000;
        let reachedAt: number | null = null;
        for (let at = 0; at < 20_000; at += 50) {
            if (at === joinedAt) connectWebRtc();
            calls.push(watch(api.getSetting(`burst-${at}`)));
            await run(50, 50);
            if (reachedAt === null && phoneHybrid.peerPath?.('host') === 'direct') reachedAt = at;
        }
        await run(10_000, 250);
        expect(reachedAt).not.toBeNull();
        expect((reachedAt ?? 0) - joinedAt).toBeLessThanOrEqual(3_000);
        expect(calls.filter(({ state }) => state !== 'resolved')).toEqual([]);
        const ran = invoked.filter(({ channel }) => channel === 'get-setting').map(({ args }) => args[0]);
        expect(new Set(ran).size).toBe(calls.length);
        expect(phoneEvents).toEqual([]);
    });

    test('the relay link giving up during the drain drops the held sends, and a held spend answers unclear without ever being sent', async () => {
        // X is started on the relay and never acknowledged; the spend made while the phone waits is held.
        bus.filter = (frame) => !(frame.header.kind === 'ack' && frame.header.from === 'host');
        watch(api.setSetting('k', 'X'));
        await run(300);
        connectWebRtc();
        const spend = watch(api.keyUnlockBoost('c1', true));
        await run(100);
        expect(spend.state).toBe('pending');
        await run(20_000, 250); // the relay link gives up on X: the peer was still on the relay
        expect(spend.state).toBe('resolved');
        expect((spend.value as { error?: string }).error).toContain('before retrying');
        expect(invoked.some(({ channel }) => channel === 'key-unlock-boost')).toBe(false);
    });
});

describe('the relay link giving up on a peer that is on WebRTC now', () => {
    const hostHello = {
        t: 'hello',
        version: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: true,
    };
    let direct: TransportStub;
    let relay: TransportStub;
    let api: Api;

    beforeEach(() => {
        jest.useFakeTimers();
        setRemoteConnectionState('connecting');
        direct = new TransportStub('phone');
        relay = new TransportStub('phone');
        installPeerBridge(createHybridTransport({ direct, relay, role: 'phone' }));
        api = (globalThis as { api?: Api }).api ?? {};
        relay.emitJoin('host');
        relay.receiveFromPeer(hostHello, 'host');
        expect(remoteConnectionState()).toBe('connected');
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
        setRemoteHostPath('direct');
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    test('with relay messages never acknowledged, the invokes in flight are settled and a spend answers unclear', async () => {
        const plain = (api.getSetting('plain') as Promise<unknown>).then(
            () => 'resolved',
            () => 'rejected',
        );
        const spend = api.keyUnlockBoost('c1', true) as Promise<unknown>;
        direct.emitJoin('host'); // upgraded while both are still on the relay
        expect(remoteHostPath()).toBe('direct');
        relay.emitLeave('host', 2); // the relay link gave up on messages it had sent
        expect(await plain).toBe('rejected');
        const answer = (await spend) as { success?: boolean; error?: string };
        expect(answer.error).toContain('before retrying');
        // Leave, then join as direct: the bridge asks for the desktop again.
        expect(remoteConnectionState()).toBe('connecting');
    });

    test('with nothing unacknowledged, the same relay loss settles nothing: the answer still comes over WebRTC', async () => {
        const pending = api.getSetting('plain') as Promise<unknown>;
        await flush();
        const sent = relay.sent
            .map(({ message }) => message as { t: string; id: number })
            .find(({ t }) => t === 'invoke');
        expect(sent).toBeDefined();
        direct.emitJoin('host');
        relay.emitLeave('host', 0);
        await Promise.resolve();
        expect(remoteConnectionState()).toBe('connected');
        direct.receiveFromPeer({ t: 'result', id: sent?.id, ok: true, result: 'answer' }, 'host');
        await expect(pending).resolves.toBe('answer');
    });

    test('the relay link giving up while the phone waits for it to drain finds the peer on the relay: a leave and a join, and a spend answers unclear', async () => {
        const spend = api.keyUnlockBoost('c1', true) as Promise<unknown>;
        relay.inFlightCounts.set('host', 1);
        direct.emitJoin('host'); // waits: the spend is in flight on the relay
        expect(remoteHostPath()).toBe('relay');
        relay.emitLeave('host', 1);
        const answer = (await spend) as { error?: string };
        expect(answer.error).toContain('before retrying');
        expect(remoteConnectionState()).toBe('connecting');
    });

    test('a message handed back at the upgrade whose WebRTC send fails settles what was in flight, though no path reported a leave', async () => {
        const spend = api.keyUnlockBoost('c1', true) as Promise<unknown>;
        await Promise.resolve();
        // The spend is queued on the relay link and has not started: the upgrade hands it back.
        relay.unsent.set(
            'host',
            relay.sent.map(({ message }) => message),
        );
        direct.failNextSendOnce();
        direct.emitJoin('host');
        const answer = (await spend) as { error?: string };
        expect(answer.error).toContain('before retrying');
    });
});
