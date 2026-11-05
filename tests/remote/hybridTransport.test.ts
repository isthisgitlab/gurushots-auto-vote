/**
 * The hybrid transport over two stub transports: a peer joins on the path that reaches it first, a relay
 * peer that WebRTC then reaches moves to direct in place (with what the relay had not started), what a
 * dropped path does, how a WebRTC join error is held back, and that messages count from either path.
 */

import { JOIN_ERROR_HOLD_MS, createHybridTransport } from '../../src/ts/core/remote/hybridTransport';
import { MAX_QUEUED_FRAMES } from '../../src/ts/core/remote/relayOutbox';
import { TransportStub } from '../helpers/remoteTransport';

import type { RemotePath, RemoteTransport } from '../../src/ts/core/remote/relays';

const SDP_FAILURE = 'could not connect to peer abc after exchanging SDP';

describe('createHybridTransport', () => {
    let direct: TransportStub;
    let relay: TransportStub;
    let hybrid: RemoteTransport;
    let events: string[];
    let errors: Array<{ error: string; peerId: string }>;
    let messages: Array<[string, unknown]>;
    let pathChanges: Array<[string, RemotePath]>;

    const build = (
        withRelay = true,
        role: 'host' | 'phone' = 'phone',
        isSafeDuplicate?: (message: unknown) => boolean,
    ): void => {
        hybrid = createHybridTransport({ direct, relay: withRelay ? relay : null, role, isSafeDuplicate });
        hybrid.onPeerJoin((peerId) => events.push(`join:${peerId}:${hybrid.peerPath?.(peerId)}`));
        hybrid.onPeerLeave((peerId) => events.push(`leave:${peerId}`));
        hybrid.onJoinError((details) => errors.push(details));
        hybrid.onMessage((peerId, message) => messages.push([peerId, message]));
        hybrid.onPathChange?.((peerId, path) => pathChanges.push([peerId, path]));
    };

    beforeEach(() => {
        jest.useFakeTimers();
        direct = new TransportStub('me');
        relay = new TransportStub('me');
        events = [];
        errors = [];
        messages = [];
        pathChanges = [];
        build();
    });
    afterEach(() => jest.useRealTimers());

    describe('choosing the path', () => {
        test('a peer joins on the path that reaches it first, at once: no wait', () => {
            relay.emitJoin('r');
            direct.emitJoin('d');
            expect(events).toEqual(['join:r:relay', 'join:d:direct']);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('the other path joining a peer that is already joined changes nothing for a direct peer', () => {
            direct.emitJoin('p');
            relay.emitJoin('p');
            direct.emitJoin('p');
            jest.advanceTimersByTime(60_000);
            expect(events).toEqual(['join:p:direct']);
            expect(pathChanges).toEqual([]);
        });

        test('WebRTC joining a relay peer later moves it to direct in place: no leave, no second join, one path change', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(10_000);
            direct.emitJoin('p');
            expect(events).toEqual(['join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('direct');
            expect(pathChanges).toEqual([['p', 'direct']]);
            jest.advanceTimersByTime(60_000);
            expect(events).toEqual(['join:p:relay']);
        });

        test('an upgrade takes back what the relay had queued and not started, and sends it over WebRTC in order', async () => {
            relay.emitJoin('p');
            relay.unsent.set('p', [{ t: 'one' }, { t: 'two' }]);
            direct.emitJoin('p');
            expect(direct.sent).toEqual([
                { message: { t: 'one' }, target: 'p' },
                { message: { t: 'two' }, target: 'p' },
            ]);
            expect(relay.unsent.has('p')).toBe(false);
            // From now on a send goes over WebRTC, after what was moved.
            await hybrid.send({ t: 'three' }, 'p');
            expect(direct.sent.map(({ message }) => message)).toEqual([{ t: 'one' }, { t: 'two' }, { t: 'three' }]);
            expect(relay.sent).toEqual([]);
        });

        test('an upgrade with no relay link that hands messages back moves nothing', () => {
            relay.emitJoin('p');
            Object.defineProperty(relay, 'takeUnsent', { value: undefined });
            direct.emitJoin('p');
            expect(direct.sent).toEqual([]);
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('a WebRTC join error for a peer the relay link reaches is no news: nothing is forwarded', () => {
            relay.emitJoin('p');
            direct.emitJoinError(SDP_FAILURE, 'p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
            expect(events).toEqual(['join:p:relay']);
        });

        test('a relay peer that leaves is gone; a later WebRTC join joins it as direct', () => {
            relay.emitJoin('p');
            relay.emitLeave('p');
            direct.emitJoin('p');
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:direct']);
            expect(pathChanges).toEqual([]);
        });

        test('a path-change handler is removed by its unsubscribe', () => {
            const seen: string[] = [];
            const off = hybrid.onPathChange?.((peerId) => seen.push(peerId));
            off?.();
            relay.emitJoin('p');
            direct.emitJoin('p');
            expect(seen).toEqual([]);
        });
    });

    /** A fresh pair of stubs and a hybrid of the given side. */
    const rebuild = (role: 'host' | 'phone', isSafeDuplicate?: (message: unknown) => boolean): void => {
        direct = new TransportStub('me');
        relay = new TransportStub('me');
        events = [];
        messages = [];
        pathChanges = [];
        build(true, role, isSafeDuplicate);
    };
    const settle = async (): Promise<void> => {
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    };
    const sentOverDirect = (): unknown[] => direct.sent.map(({ message }) => message);
    const sentOverRelay = (): unknown[] => relay.sent.map(({ message }) => message);
    /** A message the desktop may send twice, for these tests: a result. */
    const safe = (message: unknown): boolean => (message as { t: string }).t === 'result';

    describe('an upgrade on the desktop side', () => {
        beforeEach(() => rebuild('host', safe));

        test('moves the unstarted messages to WebRTC in order, and copies the started ones that are safe to send twice, before them', () => {
            relay.emitJoin('p');
            relay.started.set('p', [
                { t: 'result', n: 1 },
                { t: 'event', n: 2 },
                { t: 'result', n: 3 },
            ]);
            relay.unsent.set('p', [
                { t: 'event', n: 4 },
                { t: 'result', n: 5 },
            ]);
            direct.emitJoin('p');
            expect(sentOverDirect()).toEqual([
                { t: 'result', n: 1 },
                { t: 'result', n: 3 },
                { t: 'event', n: 4 },
                { t: 'result', n: 5 },
            ]);
            expect(relay.unsent.has('p')).toBe(false); // moved
            expect(relay.started.get('p')).toHaveLength(3); // the started ones stay with the relay link, which goes on sending them
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('copies nothing that started when no predicate says a copy is safe', () => {
            rebuild('host');
            relay.emitJoin('p');
            relay.started.set('p', [{ t: 'result' }]);
            relay.unsent.set('p', [{ t: 'event' }]);
            direct.emitJoin('p');
            expect(sentOverDirect()).toEqual([{ t: 'event' }]);
        });

        test('a message still being packed when the upgrade happens goes over WebRTC when it is ready, after the others', async () => {
            relay.emitJoin('p');
            relay.unsent.set('p', [{ t: 'moved' }]);
            direct.emitJoin('p');
            relay.redirects.get('p')?.({ t: 'late' });
            expect(sentOverDirect()).toEqual([{ t: 'moved' }, { t: 'late' }]);
            await hybrid.send({ t: 'after' }, 'p');
            expect(sentOverDirect()).toEqual([{ t: 'moved' }, { t: 'late' }, { t: 'after' }]);
            expect(sentOverRelay()).toEqual([]);
        });

        test('the redirect ends when the peer leaves, so a message for a peer reached again is queued on the relay link', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            expect(relay.redirects.has('p')).toBe(true);
            direct.emitLeave('p');
            expect(relay.redirects.has('p')).toBe(false);
            expect(relay.stoppedRedirects.at(-1)).toBe('p');
        });

        test('the redirect also ends when the peer joins again: after the relay link gave up and WebRTC was lost, a stale redirect cannot swallow the messages of the same id coming back over the relay', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            relay.emitLeave('p', 2); // the desktop ignores it: the peer stays on WebRTC with the redirect
            expect(relay.redirects.has('p')).toBe(true);
            direct.emitLeave('p'); // WebRTC lost too: a leave, and nothing reaches the peer
            relay.redirect('p', () => undefined); // a redirect left behind by an order of events nothing ended
            relay.emitJoin('p'); // the same id comes back over the relay
            expect(relay.redirects.has('p')).toBe(false);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('a relay link that cannot hand messages back moves nothing', () => {
            relay.emitJoin('p');
            for (const name of ['startedMessages', 'takeUnsent', 'redirect']) {
                Object.defineProperty(relay, name, { value: undefined });
            }
            direct.emitJoin('p');
            expect(direct.sent).toEqual([]);
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('a message whose WebRTC send fails is a WebRTC loss: the peer leaves, then joins as relay', async () => {
            relay.emitJoin('p');
            relay.unsent.set('p', [{ t: 'one' }]);
            direct.failNextSendOnce();
            direct.emitJoin('p');
            await settle();
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('a late message whose WebRTC send fails is a WebRTC loss too', async () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            direct.failNextSendOnce();
            relay.redirects.get('p')?.({ t: 'late' });
            await settle();
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:relay']);
        });

        test('the relay link giving up on a direct peer is never a leave: the results were copied, and its pushes must not stop', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            relay.emitLeave('p', 3);
            expect(events).toEqual(['join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('direct');
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('nothing is sent over WebRTC after the transport left, not even a late message', async () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            await hybrid.leave();
            relay.redirects.get('p')?.({ t: 'late' });
            expect(direct.sent).toEqual([]);
        });
    });

    describe('an upgrade on the phone side', () => {
        beforeEach(() => rebuild('phone'));

        test('waits while the relay link has a message in flight: the peer stays on the relay, and new sends are held here, not given to the relay link', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 2);
            direct.emitJoin('p');
            expect(hybrid.peerPath?.('p')).toBe('relay');
            expect(pathChanges).toEqual([]);
            await hybrid.send({ t: 'held 1' }, 'p'); // resolves at once
            await hybrid.send({ t: 'held 2' }, 'p');
            expect(sentOverRelay()).toEqual([]);
            expect(direct.sent).toEqual([]);
        });

        test('switches when nothing is in flight: the unstarted messages go over WebRTC in order, then the held ones, then the path change is heard', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            relay.unsent.set('p', [{ t: 'one' }, { t: 'two' }]);
            await hybrid.send({ t: 'held 1' }, 'p');
            await hybrid.send({ t: 'held 2' }, 'p');
            hybrid.onPathChange?.((peerId, path) => events.push(`path:${peerId}:${path}:${direct.sent.length}`));
            relay.becomeIdle('p');
            expect(sentOverDirect()).toEqual([{ t: 'one' }, { t: 'two' }, { t: 'held 1' }, { t: 'held 2' }]);
            expect(events).toEqual(['join:p:relay', 'path:p:direct:4']);
            expect(pathChanges).toEqual([['p', 'direct']]);
            await hybrid.send({ t: 'three' }, 'p');
            expect(sentOverDirect().slice(-1)).toEqual([{ t: 'three' }]);
            expect(sentOverRelay()).toEqual([]);
        });

        test('switches at once when nothing is in flight', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            expect(hybrid.peerPath?.('p')).toBe('direct');
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('a second WebRTC join while waiting does not start a second wait', () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            direct.emitJoin('p');
            expect(relay.idleWaiters.get('p')?.size).toBe(1);
            relay.becomeIdle('p');
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('WebRTC dropping during the wait is a leave, then a join on the relay: the wait ends and the held sends are dropped, their invokes being settled by the leave', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            await hybrid.send({ t: 'held 1' }, 'p');
            await hybrid.send({ t: 'held 2' }, 'p');
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:relay']);
            expect(relay.idleWaiters.get('p')?.size).toBe(0);
            expect(sentOverRelay()).toEqual([]);
            expect(direct.sent).toEqual([]);
            relay.becomeIdle('p');
            expect(hybrid.peerPath?.('p')).toBe('relay');
            expect(pathChanges).toEqual([]);
            await hybrid.send({ t: 'later' }, 'p'); // not held any more
            expect(sentOverRelay()).toEqual([{ t: 'later' }]);
        });

        test('WebRTC dropping during the wait with the relay link gone too just leaves', () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            relay.emitLeave('p'); // the relay link is gone, and the peer moves to WebRTC alone
            events.length = 0;
            direct.emitLeave('p');
            expect(events).toEqual(['leave:p']);
        });

        test('the held sends are capped at the relay queue: a send past the cap is refused, and the ones held stay held', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            for (let n = 0; n < MAX_QUEUED_FRAMES; n++) await hybrid.send({ n }, 'p');
            await expect(hybrid.send({ t: 'one too many' }, 'p')).rejects.toThrow('relay send queue is full');
            relay.becomeIdle('p');
            const sent = sentOverDirect();
            expect(sent).toHaveLength(MAX_QUEUED_FRAMES);
            expect(sent[0]).toEqual({ n: 0 });
            expect(sent[MAX_QUEUED_FRAMES - 1]).toEqual({ n: MAX_QUEUED_FRAMES - 1 });
        });

        test('the relay link giving up during the wait finds the peer still on the relay: it leaves, then joins as direct, and the held sends are dropped', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            await hybrid.send({ t: 'held' }, 'p');
            relay.emitLeave('p', 1);
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:direct']);
            expect(relay.idleWaiters.get('p')?.size).toBe(0);
            relay.becomeIdle('p');
            expect(pathChanges).toEqual([]);
            expect(direct.sent).toEqual([]);
            expect(sentOverRelay()).toEqual([]);
        });

        test('a relay link with no idle callback upgrades at once', () => {
            relay.emitJoin('p');
            Object.defineProperty(relay, 'whenIdle', { value: undefined });
            direct.emitJoin('p');
            expect(pathChanges).toEqual([['p', 'direct']]);
        });

        test('a message handed back whose WebRTC send fails is a WebRTC loss: the peer leaves, then joins as relay', async () => {
            relay.emitJoin('p');
            relay.unsent.set('p', [{ t: 'one' }]);
            direct.failNextSendOnce();
            direct.emitJoin('p');
            await settle();
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:relay']);
        });

        test('the relay link losing a direct peer that it had unacknowledged messages for leaves, then joins as direct', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            relay.emitLeave('p', 1);
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:direct']);
        });

        test('leaving while waiting cancels the wait and drops the held sends: nothing moves, sends or is announced afterwards', async () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            await hybrid.send({ t: 'held' }, 'p');
            await hybrid.leave();
            expect(relay.idleWaiters.get('p')?.size).toBe(0);
            relay.becomeIdle('p');
            expect(pathChanges).toEqual([]);
            expect(direct.sent).toEqual([]);
            expect(sentOverRelay()).toEqual([]);
        });

        test('after leave every path event is ignored: no join, leave, message or join error is announced', async () => {
            const errors: unknown[] = [];
            hybrid.onJoinError((details) => errors.push(details));
            await hybrid.leave();
            events.length = 0;
            messages.length = 0;
            relay.emitJoin('r');
            direct.emitJoin('d');
            relay.receiveFromPeer({ t: 'x' }, 'r');
            direct.receiveFromPeer({ t: 'y' }, 'd');
            direct.emitJoinError(SDP_FAILURE, 'z');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            relay.emitLeave('r');
            direct.emitLeave('d');
            expect(events).toEqual([]);
            expect(messages).toEqual([]);
            expect(errors).toEqual([]);
            expect(hybrid.peerPath?.('r')).toBeNull();
            expect(hybrid.peerPath?.('d')).toBeNull();
        });

        test('an upgrade that was already waiting when the transport left does nothing if it fires', () => {
            relay.emitJoin('p');
            relay.inFlightCounts.set('p', 1);
            direct.emitJoin('p');
            const callbacks = [...(relay.idleWaiters.get('p') ?? [])];
            void hybrid.leave();
            for (const callback of callbacks) callback(); // a callback the relay link still held
            expect(pathChanges).toEqual([]);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });
    });

    describe('a path that drops', () => {
        test('a direct peer whose WebRTC drops while the relay link reaches it leaves, then joins as relay', () => {
            relay.emitJoin('p');
            direct.emitJoin('p'); // upgraded
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('a direct peer whose WebRTC drops with nothing else reaching it just leaves', () => {
            direct.emitJoin('p');
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:direct', 'leave:p']);
            expect(hybrid.peerPath?.('p')).toBeNull();
        });

        test('the relay link giving up on a direct peer with messages never acknowledged leaves, then joins as direct', () => {
            relay.emitJoin('p');
            direct.emitJoin('p'); // upgraded; some message it had sent on the relay is still unacknowledged
            relay.emitLeave('p', 2);
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:direct']);
            expect(hybrid.peerPath?.('p')).toBe('direct');
        });

        test('the relay link giving up on a direct peer whose WebRTC is gone too just leaves', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            direct.emitLeave('p'); // downgraded to relay
            events.length = 0;
            relay.emitLeave('p', 3);
            expect(events).toEqual(['leave:p']);
        });

        test('the relay link ending for a direct peer with nothing unacknowledged changes nothing', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            relay.emitLeave('p');
            relay.emitLeave('p', 0);
            expect(events).toEqual(['join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('direct');
        });

        test('a peer that was never reached by WebRTC losing it changes nothing', () => {
            relay.emitJoin('q');
            direct.emitLeave('q');
            expect(events).toEqual(['join:q:relay']);
        });
    });

    describe('join errors', () => {
        test('are held back for 12 s while the relay link may still reach the peer, then forwarded unchanged', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS - 1);
            expect(errors).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(errors).toEqual([{ error: SDP_FAILURE, peerId: 'p' }]);
        });

        test('a second error for a peer already held does not hold or forward it twice', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            direct.emitJoinError(SDP_FAILURE, 'p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toHaveLength(1);
        });

        test('are dropped if the relay link joins the peer meanwhile', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            relay.emitJoin('p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
            expect(events).toEqual(['join:p:relay']);
        });

        test('a relay join stops the held error at once, and the peer joins as relay', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            expect(jest.getTimerCount()).toBe(1); // the hold
            relay.emitJoin('p');
            expect(jest.getTimerCount()).toBe(0);
            expect(events).toEqual(['join:p:relay']);
        });

        test('are dropped if a message proves the peer reachable meanwhile', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            relay.receiveFromPeer({ t: 'hello' }, 'p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
        });

        test('are dropped at once for a peer the relay link reaches or that is already joined', () => {
            relay.emitJoin('p');
            direct.emitJoinError(SDP_FAILURE, 'p');
            direct.emitJoin('q');
            direct.emitJoinError(SDP_FAILURE, 'q');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
        });

        test('are forwarded at once where there is no relay link to wait for', () => {
            build(false);
            direct.emitJoinError(SDP_FAILURE, 'p');
            expect(errors).toEqual([{ error: SDP_FAILURE, peerId: 'p' }]);
        });
    });

    describe('messages and sends', () => {
        test('messages count from either path, whatever path the peer was joined on', () => {
            direct.emitJoin('p');
            relay.receiveFromPeer({ t: 'a' }, 'p');
            direct.receiveFromPeer({ t: 'b' }, 'p');
            expect(messages).toEqual([
                ['p', { t: 'a' }],
                ['p', { t: 'b' }],
            ]);
            expect(events).toEqual(['join:p:direct']);
        });

        test('a message from a relay peer joins it as relay once, and only once', () => {
            relay.receiveFromPeer({ t: 'hello' }, 'p');
            relay.emitJoin('p');
            relay.receiveFromPeer({ t: 'again' }, 'p');
            expect(events).toEqual(['join:p:relay']);
            expect(messages).toEqual([
                ['p', { t: 'hello' }],
                ['p', { t: 'again' }],
            ]);
        });

        test('a message from a direct peer whose join was not seen joins it as direct', () => {
            direct.receiveFromPeer({ t: 'hello' }, 'p');
            expect(events).toEqual(['join:p:direct']);
        });

        test('a send goes over the path the peer joined on', async () => {
            direct.emitJoin('d');
            relay.emitJoin('r');
            await hybrid.send({ t: 'one' }, 'd');
            await hybrid.send({ t: 'two' }, 'r');
            expect(direct.sent).toEqual([{ message: { t: 'one' }, target: 'd' }]);
            expect(relay.sent).toEqual([{ message: { t: 'two' }, target: 'r' }]);
        });

        test('a send needs a target the transport has joined', async () => {
            await expect(hybrid.send({ t: 'x' })).rejects.toThrow('not connected');
            await expect(hybrid.send({ t: 'x' }, 'stranger')).rejects.toThrow('not connected');
            expect(direct.sent).toEqual([]);
            expect(relay.sent).toEqual([]);
        });
    });

    describe('the rest of the surface', () => {
        test('answers whether the relay link is there, and no path for a peer that is not joined', () => {
            expect(hybrid.relayAvailable?.()).toBe(true);
            expect(hybrid.peerPath?.('nobody')).toBeNull();
            build(false);
            expect(hybrid.relayAvailable?.()).toBe(false);
        });

        test('handlers are removed by their unsubscribe', () => {
            const seen: string[] = [];
            const off = hybrid.onPeerJoin((peerId) => seen.push(peerId));
            off();
            direct.emitJoin('p');
            expect(seen).toEqual([]);
        });

        test('leave leaves both paths and cancels every wait', async () => {
            direct.emitJoinError(SDP_FAILURE, 'q'); // a held error
            await hybrid.leave();
            expect(direct.left).toBe(true);
            expect(relay.left).toBe(true);
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(events).toEqual([]);
            expect(errors).toEqual([]);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('leave without a relay link leaves the direct path alone', async () => {
            build(false);
            await hybrid.leave();
            expect(direct.left).toBe(true);
            expect(relay.left).toBe(false);
        });
    });
});
