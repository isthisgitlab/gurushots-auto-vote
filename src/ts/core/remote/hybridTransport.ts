/**
 * One transport over both paths to a peer: the WebRTC room (`direct`) and the relay link
 * (`relay`). WebRTC is the preferred path, and no wait is spent on it:
 *
 * - a peer joins on whichever path reaches it first;
 * - a peer that joined on the relay and is then reached by WebRTC moves to `direct` in place, with no leave
 *   and no join (an upgrade), and the listeners hear `onPathChange`. What happens to the messages the relay
 *   link still holds for the peer depends on which way they go, and `role` says:
 *   - the desktop (`host`) sends results, events and states. At an upgrade it moves every message the relay link
 *     has queued and not started to WebRTC, in order (they have no sequence number yet, so the relay stream
 *     keeps no gap), and the messages that finish packing later go there too. A message the relay link has started
 *     and not had acknowledged stays with the relay link, which goes on sending it, so the stream has no gap;
 *     it is also sent over WebRTC when `isSafeDuplicate` says a second copy does no harm (a `hello`, a
 *     `result` the phone ignores once its invoke is settled, a stamped `autovote-state`). An event that
 *     started is not copied: it finishes on the relay, and is lost if the relay gives up on the peer. The relay
 *     link giving up on a peer that is `direct` is never a leave for the desktop: the results were copied, and
 *     dropping the phone would stop its pushes with no notice;
 *   - the phone (`phone`) sends invokes and commands, which a duplicate would do harm to (a spend could run
 *     twice) and whose order matters (two writes to one setting). It drains, then switches: the peer stays on
 *     the relay for sending while the relay link has a message to it in flight (waiting to be packed, packing,
 *     or started and not acknowledged), and new sends for it are held here, in order, instead of going to the
 *     relay link, so the drain ends once what is in flight is acknowledged however fast the page sends. When
 *     nothing is in flight the messages the relay link queued and did not start are taken back and go over
 *     WebRTC, then the held ones, in order, and the peer moves to `direct`. A relay that gives up during the
 *     drain finds the peer still on the relay: a leave and a join, which settles everything in flight (a spend as
 *     unclear) and drops the held sends, whose invokes that leave settles. WebRTC lost during the drain is the same: the
 *     desktop upgraded at once and may have answered over WebRTC, so nothing sent on the relay can be taken as
 *     answered. The held sends are capped at the relay queue's size, and a send past it is refused as the queue refuses one;
 *   A taken-back message whose WebRTC send fails is a WebRTC loss for that peer, which settles it;
 * - if a `direct` peer's WebRTC connection drops while the relay link still reaches it, that is
 *   a leave and then a `relay` join (a downgrade; a dropped connection is a leave today too), so the
 *   bridge's leave handling settles what was in flight and says hello again;
 * - on the phone, if the relay link gives up on a peer that is `direct` now while messages it sent on the relay
 *   were never acknowledged, that is a leave and then a `direct` join too: an invoke sent on the
 *   relay may never have arrived, and only a leave settles it;
 * - messages are accepted from either path whatever path the peer was joined on, because the
 *   two ends may classify the same peer differently for a moment;
 * - a WebRTC join error is held back while the relay link may still reach the peer, dropped if
 *   it does, and forwarded unchanged if it does not, so "try Wi-Fi" still shows.
 *
 * The two transports are injected; the only import is the relay queue's size.
 */

import { MAX_QUEUED_FRAMES } from './relayOutbox';

import type { RemotePath, RemoteTransport } from './relays';

/** How long a WebRTC join error is held back while the relay link may still reach the peer. */
export const JOIN_ERROR_HOLD_MS = 12_000;

type JoinErrorDetails = { error: string; peerId: string };

export type HybridOptions = {
    direct: RemoteTransport;
    /** The relay link, or null where it cannot run (a browser without `CompressionStream`): the transport is then the direct one alone. */
    relay: RemoteTransport | null;
    /** Which side this transport is for: the two sides treat the messages the relay link holds at an upgrade differently (see the head of this file). */
    role: 'host' | 'phone';
    /** The desktop only: whether a message the relay link already started may also be sent over WebRTC at an upgrade, because a second copy of it does no harm. */
    isSafeDuplicate?: (message: unknown) => boolean;
};

const handlerSet =
    <A extends unknown[]>(set: Set<(...args: A) => void>) =>
    (handler: (...args: A) => void): (() => void) => {
        set.add(handler);
        return () => set.delete(handler);
    };

/** What the two paths share: the peers joined, the paths that reach each, the held timers and the listeners. */
type HybridState = {
    readonly direct: RemoteTransport;
    readonly relay: RemoteTransport | null;
    readonly role: 'host' | 'phone';
    readonly isSafeDuplicate: (message: unknown) => boolean;
    /** Set by `leave`: nothing is moved, sent or announced after it. */
    closed: boolean;
    /** The peers waiting for the relay link to drain before they move to WebRTC (the phone), each with its cancel. */
    readonly draining: Map<string, () => void>;
    /** The sends made to a draining peer, in order: they go over WebRTC when the peer moves, or to the relay link if WebRTC is lost first. */
    readonly holds: Map<string, unknown[]>;
    /** The joined peers and the path each was joined on. */
    readonly paths: Map<string, RemotePath>;
    readonly directUp: Set<string>;
    readonly relayUp: Set<string>;
    readonly errorTimers: Map<string, ReturnType<typeof setTimeout>>;
    readonly messageHandlers: Set<(peerId: string, message: unknown) => void>;
    readonly joinHandlers: Set<(peerId: string) => void>;
    readonly leaveHandlers: Set<(peerId: string) => void>;
    readonly pathHandlers: Set<(peerId: string, path: RemotePath) => void>;
    readonly errorHandlers: Set<(details: JoinErrorDetails) => void>;
};

const stopTimer = (timers: Map<string, ReturnType<typeof setTimeout>>, peerId: string): void => {
    const timer = timers.get(peerId);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timers.delete(peerId);
};

const join = (state: HybridState, peerId: string, path: RemotePath): void => {
    stopTimer(state.errorTimers, peerId); // reachable after all: a held join error is dropped
    state.paths.set(peerId, path);
    for (const handler of state.joinHandlers) handler(peerId);
};

/** Stops a peer's wait for the relay to drain, if it has one. */
const cancelDrain = (state: HybridState, peerId: string): void => {
    state.draining.get(peerId)?.();
    state.draining.delete(peerId);
};

const leave = (state: HybridState, peerId: string): void => {
    cancelDrain(state, peerId);
    state.holds.delete(peerId); // the leave settles the invokes these were made for
    state.relay?.stopRedirect?.(peerId); // the peer is gone, or is about to be reached again: messages for it are queued on the relay link again
    state.paths.delete(peerId);
    for (const handler of state.leaveHandlers) handler(peerId);
};

/**
 * A peer's path ended; if the other path still reaches it, it joins on that one. The relay link ending
 * for a peer that is `direct` now changes nothing, except on the phone when it gave up on messages that were
 * never acknowledged (`unacked`): those may never have arrived, so the peer leaves and joins again, which
 * settles what was in flight. The desktop never leaves for it: it sent results, which were copied to WebRTC.
 * WebRTC ending for a peer the phone is still draining is a leave too, though the peer is on the relay.
 */
const lose = (state: HybridState, peerId: string, path: RemotePath, unacked = 0): void => {
    const current = state.paths.get(peerId);
    const phoneRelayLoss = state.role === 'phone' && path === 'relay' && current === 'direct' && unacked > 0;
    // WebRTC lost while the phone drains: the desktop answers over WebRTC from its upgrade on, so what the phone sent on the relay is unclear.
    const drainLoss = path === 'direct' && current === 'relay' && state.draining.has(peerId);
    if (current !== path && !phoneRelayLoss && !drainLoss) return;
    leave(state, peerId);
    if ((path === 'direct' ? state.relayUp : state.directUp).has(peerId))
        join(state, peerId, path === 'direct' ? 'relay' : 'direct');
};

/** Sends a message the relay link handed back over WebRTC; a send that fails is a WebRTC loss for the peer, which settles what was in flight. */
const sendDirect = (state: HybridState, message: unknown, peerId: string): void => {
    if (state.closed) return;
    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
    state.direct.send(message, peerId).catch(() => lose(state, peerId, 'direct'));
};

/**
 * A peer on the relay moves to `direct` in place. The messages that go over WebRTC with it, in order: on the desktop
 * the started ones that are safe to send twice, then the ones the relay link queued and did not start (and the ones
 * still being packed, when they are ready); on the phone the ones the relay link queued and did not start, then
 * the sends held while it drained.
 */
const upgrade = (state: HybridState, peerId: string): void => {
    if (state.closed) return;
    const { relay } = state;
    const copies: unknown[] = [];
    if (state.role === 'host') {
        relay?.redirect?.(peerId, (late) => sendDirect(state, late, peerId));
        copies.push(...(relay?.startedMessages?.(peerId) ?? []).filter(state.isSafeDuplicate));
    }
    const moved = relay?.takeUnsent?.(peerId) ?? [];
    const held = state.holds.get(peerId) ?? [];
    state.holds.delete(peerId);
    state.paths.set(peerId, 'direct');
    for (const message of [...copies, ...moved, ...held]) sendDirect(state, message, peerId);
    for (const handler of state.pathHandlers) handler(peerId, 'direct');
};

/**
 * WebRTC reached a peer that is on the relay. The desktop upgrades at once. The phone waits for the relay link to
 * have nothing in flight for the peer first.
 */
const beginUpgrade = (state: HybridState, peerId: string): void => {
    const idle = state.relay?.whenIdle;
    if (state.role === 'host' || idle === undefined) {
        upgrade(state, peerId);
        return;
    }
    if (state.draining.has(peerId)) return;
    let waiting = true;
    // A leave of either path cancels the wait (and the relay link drops it when the peer goes), so a callback that runs finds the peer on the relay with WebRTC up.
    const cancel = idle.call(state.relay, peerId, () => {
        waiting = false;
        state.draining.delete(peerId);
        upgrade(state, peerId);
    });
    if (waiting) state.draining.set(peerId, cancel);
};

/** A message from a peer not joined yet is proof enough: it joins on the path it spoke on. */
const deliver = (state: HybridState, peerId: string, message: unknown, path: RemotePath): void => {
    if (!state.paths.has(peerId)) join(state, peerId, path);
    for (const handler of state.messageHandlers) handler(peerId, message);
};

const onDirectJoinError = (state: HybridState, details: JoinErrorDetails): void => {
    const { peerId } = details;
    if (state.paths.has(peerId) || state.relayUp.has(peerId)) return; // reachable another way: the failure is no news
    if (state.relay === null) {
        for (const handler of state.errorHandlers) handler(details);
        return;
    }
    if (state.errorTimers.has(peerId)) return;
    state.errorTimers.set(
        peerId,
        // A join (on either path) cancels this timer, so a held error that fires is for a peer nobody reached.
        globalThis.setTimeout(() => {
            state.errorTimers.delete(peerId);
            for (const handler of state.errorHandlers) handler(details);
        }, JOIN_ERROR_HOLD_MS),
    );
};

/** A path event after `leave` is ignored: no join, leave or message is announced once the transport is closed. */
const whileOpen =
    <A extends unknown[]>(state: HybridState, handler: (...args: A) => void) =>
    (...args: A): void => {
        if (!state.closed) handler(...args);
    };

const wireDirect = (state: HybridState): void => {
    const { direct } = state;
    direct.onPeerJoin(
        whileOpen(state, (peerId: string) => {
            state.directUp.add(peerId);
            const path = state.paths.get(peerId);
            if (path === undefined) join(state, peerId, 'direct');
            else if (path === 'relay') beginUpgrade(state, peerId);
        }),
    );
    direct.onPeerLeave(
        whileOpen(state, (peerId: string) => {
            state.directUp.delete(peerId);
            lose(state, peerId, 'direct');
        }),
    );
    direct.onMessage(whileOpen(state, (peerId: string, message: unknown) => deliver(state, peerId, message, 'direct')));
    direct.onJoinError(whileOpen(state, (details: JoinErrorDetails) => onDirectJoinError(state, details)));
};

const wireRelay = (state: HybridState): void => {
    const { relay } = state;
    relay?.onPeerJoin(
        whileOpen(state, (peerId: string) => {
            state.relayUp.add(peerId);
            stopTimer(state.errorTimers, peerId); // the relay link reaches the peer after all: a held join error is dropped
            if (!state.paths.has(peerId)) join(state, peerId, 'relay');
        }),
    );
    relay?.onPeerLeave(
        whileOpen(state, (peerId: string, unacked?: number) => {
            state.relayUp.delete(peerId);
            lose(state, peerId, 'relay', unacked);
        }),
    );
    relay?.onMessage(whileOpen(state, (peerId: string, message: unknown) => deliver(state, peerId, message, 'relay')));
};

const sendTo = (state: HybridState, message: unknown, target: string | undefined): Promise<void> => {
    const { direct, relay } = state;
    const path = target === undefined ? undefined : state.paths.get(target);
    if (target === undefined || path === undefined) return Promise.reject(new Error('That peer is not connected.'));
    if (path === 'relay' && state.draining.has(target)) {
        // The peer is about to move to WebRTC: the send waits here, so the relay link can run dry, and resolves as a queued relay send does.
        const held = state.holds.get(target) ?? [];
        if (held.length >= MAX_QUEUED_FRAMES) return Promise.reject(new Error('relay send queue is full'));
        state.holds.set(target, [...held, message]);
        return Promise.resolve();
    }
    // A peer's path is never `relay` without a relay link: only its events join a peer there.
    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
    return (path === 'direct' ? direct : (relay as RemoteTransport)).send(message, target);
};

export const createHybridTransport = ({ direct, relay, role, isSafeDuplicate }: HybridOptions): RemoteTransport => {
    const state: HybridState = {
        direct,
        relay,
        role,
        isSafeDuplicate: isSafeDuplicate ?? (() => false),
        closed: false,
        draining: new Map(),
        holds: new Map(),
        paths: new Map(),
        directUp: new Set(),
        relayUp: new Set(),
        errorTimers: new Map(),
        messageHandlers: new Set(),
        joinHandlers: new Set(),
        leaveHandlers: new Set(),
        pathHandlers: new Set(),
        errorHandlers: new Set(),
    };
    wireDirect(state);
    wireRelay(state);

    return {
        send: (message, target) => sendTo(state, message, target),
        onMessage: handlerSet(state.messageHandlers),
        onPeerJoin: handlerSet(state.joinHandlers),
        onPeerLeave: handlerSet(state.leaveHandlers),
        onPathChange: handlerSet(state.pathHandlers),
        onJoinError: handlerSet(state.errorHandlers),
        leave: async () => {
            state.closed = true;
            for (const peerId of state.errorTimers.keys()) stopTimer(state.errorTimers, peerId);
            for (const peerId of [...state.draining.keys()]) cancelDrain(state, peerId);
            state.holds.clear();
            await Promise.all([relay?.leave(), direct.leave()]);
        },
        peerPath: (peerId) => state.paths.get(peerId) ?? null,
        relayAvailable: () => relay !== null,
    };
};
