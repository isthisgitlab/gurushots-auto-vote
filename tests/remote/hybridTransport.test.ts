/**
 * The hybrid transport over two stub transports: which path a peer joins on (WebRTC inside the
 * grace period, the relay link after it), that it never switches path while it lasts, what a
 * dropped path does, how a WebRTC join error is held back, and that messages count from either path.
 */

import { JOIN_ERROR_HOLD_MS, RELAY_GRACE_MS, createHybridTransport } from '../../src/ts/core/remote/hybridTransport';
import { TransportStub } from '../helpers/remoteTransport';

import type { RemoteTransport } from '../../src/ts/core/remote/relays';

const SDP_FAILURE = 'could not connect to peer abc after exchanging SDP';

describe('createHybridTransport', () => {
    let direct: TransportStub;
    let relay: TransportStub;
    let hybrid: RemoteTransport;
    let events: string[];
    let errors: Array<{ error: string; peerId: string }>;
    let messages: Array<[string, unknown]>;

    const build = (withRelay = true): void => {
        hybrid = createHybridTransport({ direct, relay: withRelay ? relay : null });
        hybrid.onPeerJoin((peerId) => events.push(`join:${peerId}:${hybrid.peerPath?.(peerId)}`));
        hybrid.onPeerLeave((peerId) => events.push(`leave:${peerId}`));
        hybrid.onJoinError((details) => errors.push(details));
        hybrid.onMessage((peerId, message) => messages.push([peerId, message]));
    };

    beforeEach(() => {
        jest.useFakeTimers();
        direct = new TransportStub('me');
        relay = new TransportStub('me');
        events = [];
        errors = [];
        messages = [];
        build();
    });
    afterEach(() => jest.useRealTimers());

    describe('choosing the path', () => {
        test('WebRTC joining inside the grace period makes the peer direct, with no leave and no second join', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS - 1_000);
            expect(events).toEqual([]);
            direct.emitJoin('p');
            expect(events).toEqual(['join:p:direct']);
            jest.advanceTimersByTime(RELAY_GRACE_MS * 2);
            expect(events).toEqual(['join:p:direct']);
            expect(hybrid.peerPath?.('p')).toBe('direct');
        });

        test('WebRTC joining first is direct at once; a later relay join changes nothing', () => {
            direct.emitJoin('p');
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS * 2);
            expect(events).toEqual(['join:p:direct']);
        });

        test('a relay join with no WebRTC is held for the grace period and then joins as relay', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS - 1);
            expect(events).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(events).toEqual(['join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('a second relay join for a peer already waiting does not restart the wait', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS - 1_000);
            relay.emitJoin('p');
            jest.advanceTimersByTime(1_000);
            expect(events).toEqual(['join:p:relay']);
        });

        test('WebRTC connecting after the grace period does not move a relay peer: no leave, no join', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS);
            direct.emitJoin('p');
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('the grace period is 3 s', () => {
            expect(RELAY_GRACE_MS).toBe(3_000);
        });

        test('a WebRTC join error for a peer waiting in its grace period ends the wait: it joins as relay at once, and the error is not forwarded', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(500);
            direct.emitJoinError(SDP_FAILURE, 'p');
            expect(events).toEqual(['join:p:relay']);
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
            expect(events).toEqual(['join:p:relay']);
        });

        test("a join error for another peer does not end this peer's grace period", () => {
            relay.emitJoin('p');
            direct.emitJoinError(SDP_FAILURE, 'q');
            expect(events).toEqual([]);
            jest.advanceTimersByTime(RELAY_GRACE_MS);
            expect(events).toEqual(['join:p:relay']);
        });

        test('a relay peer that leaves during its grace period never joins', () => {
            relay.emitJoin('p');
            relay.emitLeave('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS * 2);
            expect(events).toEqual([]);
        });
    });

    describe('a path that drops', () => {
        test('a direct peer whose WebRTC drops while the relay link reaches it leaves, then joins as relay', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:direct', 'leave:p', 'join:p:relay']);
            expect(hybrid.peerPath?.('p')).toBe('relay');
        });

        test('a direct peer whose WebRTC drops with nothing else reaching it just leaves', () => {
            direct.emitJoin('p');
            direct.emitLeave('p');
            expect(events).toEqual(['join:p:direct', 'leave:p']);
            expect(hybrid.peerPath?.('p')).toBeNull();
        });

        test('a relay peer that loses the relay link while WebRTC is up leaves, then joins as direct', () => {
            relay.emitJoin('p');
            jest.advanceTimersByTime(RELAY_GRACE_MS);
            direct.emitJoin('p');
            relay.emitLeave('p');
            expect(events).toEqual(['join:p:relay', 'leave:p', 'join:p:direct']);
        });

        test('a direct peer losing the relay link, or a relay peer losing WebRTC, changes nothing', () => {
            relay.emitJoin('p');
            direct.emitJoin('p');
            relay.emitLeave('p');
            expect(events).toEqual(['join:p:direct']);
            relay.emitJoin('q');
            jest.advanceTimersByTime(RELAY_GRACE_MS);
            direct.emitLeave('q');
            expect(events).toEqual(['join:p:direct', 'join:q:relay']);
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

        test('a relay join stops the held error at once, before the peer has even joined', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            expect(jest.getTimerCount()).toBe(1); // the hold
            relay.emitJoin('p');
            expect(jest.getTimerCount()).toBe(1); // the grace wait replaced it
            expect(events).toEqual([]);
        });

        test('are dropped if a message proves the peer reachable meanwhile', () => {
            direct.emitJoinError(SDP_FAILURE, 'p');
            relay.receiveFromPeer({ t: 'hello' }, 'p');
            jest.advanceTimersByTime(JOIN_ERROR_HOLD_MS * 2);
            expect(errors).toEqual([]);
        });

        test('are dropped at once for a peer the relay link reaches or that is already joined', () => {
            relay.emitJoin('p'); // waiting out its grace period
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

        test('a message from a relay peer still in its grace period joins it as relay first', () => {
            relay.emitJoin('p');
            relay.receiveFromPeer({ t: 'hello' }, 'p');
            expect(events).toEqual(['join:p:relay']);
            expect(messages).toEqual([['p', { t: 'hello' }]]);
            jest.advanceTimersByTime(RELAY_GRACE_MS * 2);
            expect(events).toEqual(['join:p:relay']);
        });

        test('a message from a direct peer whose join was not seen joins it as direct', () => {
            direct.receiveFromPeer({ t: 'hello' }, 'p');
            expect(events).toEqual(['join:p:direct']);
        });

        test('a send goes over the path the peer joined on', async () => {
            direct.emitJoin('d');
            relay.emitJoin('r');
            jest.advanceTimersByTime(RELAY_GRACE_MS);
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
            relay.emitJoin('p'); // a grace timer
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
