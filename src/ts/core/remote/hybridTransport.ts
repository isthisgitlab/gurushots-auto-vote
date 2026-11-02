/**
 * One transport over both paths to a peer: the WebRTC room (`direct`) and the relay link
 * (`relay`). WebRTC stays the preferred path, and a peer never switches path in a session:
 *
 * - a relay-link join is held for a short grace period while WebRTC may still connect; if WebRTC joins
 *   inside it the peer is joined as `direct`, otherwise as `relay`, and it stays there until it
 *   leaves — so the usual "relay first, WebRTC a few seconds later" race causes no leave, no
 *   settled invoke and no second "phone connected" notice;
 * - if a `direct` peer's WebRTC connection drops while the relay link still reaches it, that is
 *   a leave and then a `relay` join (a dropped connection is a leave today too), so the bridge's
 *   leave handling settles what was in flight and says hello again;
 * - messages are accepted from either path whatever path the peer was joined on, because the
 *   two ends may classify the same peer differently for a moment;
 * - a WebRTC join error is held back while the relay link may still reach the peer, dropped if
 *   it does, and forwarded unchanged if it does not, so "try Wi-Fi" still shows.
 *
 * Dependency-free: the two transports are injected.
 */

import type { RemotePath, RemoteTransport } from './relays';

/** How long a relay-link join waits for WebRTC to join first. A WebRTC join error for the peer ends the wait at once. */
export const RELAY_GRACE_MS = 3_000;

/** How long a WebRTC join error is held back while the relay link may still reach the peer. */
export const JOIN_ERROR_HOLD_MS = 12_000;

type JoinErrorDetails = { error: string; peerId: string };

export type HybridOptions = {
    direct: RemoteTransport;
    /** The relay link, or null where it cannot run (a browser without `CompressionStream`): the transport is then the direct one alone. */
    relay: RemoteTransport | null;
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
    /** The joined peers and the path each was joined on. */
    readonly paths: Map<string, RemotePath>;
    readonly directUp: Set<string>;
    readonly relayUp: Set<string>;
    readonly graceTimers: Map<string, ReturnType<typeof setTimeout>>;
    readonly errorTimers: Map<string, ReturnType<typeof setTimeout>>;
    readonly messageHandlers: Set<(peerId: string, message: unknown) => void>;
    readonly joinHandlers: Set<(peerId: string) => void>;
    readonly leaveHandlers: Set<(peerId: string) => void>;
    readonly errorHandlers: Set<(details: JoinErrorDetails) => void>;
};

const stopTimer = (timers: Map<string, ReturnType<typeof setTimeout>>, peerId: string): void => {
    const timer = timers.get(peerId);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timers.delete(peerId);
};

const join = (state: HybridState, peerId: string, path: RemotePath): void => {
    stopTimer(state.graceTimers, peerId);
    stopTimer(state.errorTimers, peerId); // reachable after all: a held join error is dropped
    state.paths.set(peerId, path);
    for (const handler of state.joinHandlers) handler(peerId);
};

const leave = (state: HybridState, peerId: string): void => {
    state.paths.delete(peerId);
    for (const handler of state.leaveHandlers) handler(peerId);
};

/** A peer's path ended; if the other path still reaches it, it joins on that one. */
const lose = (state: HybridState, peerId: string, path: RemotePath): void => {
    if (state.paths.get(peerId) !== path) return;
    leave(state, peerId);
    if ((path === 'direct' ? state.relayUp : state.directUp).has(peerId))
        join(state, peerId, path === 'direct' ? 'relay' : 'direct');
};

/** A message from a peer not joined yet (a relay peer still in its grace period) is proof enough: it joins on the path it spoke on. */
const deliver = (state: HybridState, peerId: string, message: unknown, path: RemotePath): void => {
    if (!state.paths.has(peerId)) join(state, peerId, path);
    for (const handler of state.messageHandlers) handler(peerId, message);
};

const onDirectJoinError = (state: HybridState, details: JoinErrorDetails): void => {
    const { peerId } = details;
    if (state.graceTimers.has(peerId)) {
        // WebRTC gave up on a peer the relay link already reaches: no reason to wait out the grace period.
        join(state, peerId, 'relay');
        return;
    }
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

const wireDirect = (state: HybridState): void => {
    const { direct } = state;
    direct.onPeerJoin((peerId) => {
        state.directUp.add(peerId);
        if (!state.paths.has(peerId)) join(state, peerId, 'direct');
    });
    direct.onPeerLeave((peerId) => {
        state.directUp.delete(peerId);
        lose(state, peerId, 'direct');
    });
    direct.onMessage((peerId, message) => deliver(state, peerId, message, 'direct'));
    direct.onJoinError((details) => onDirectJoinError(state, details));
};

const wireRelay = (state: HybridState): void => {
    const { relay } = state;
    relay?.onPeerJoin((peerId) => {
        state.relayUp.add(peerId);
        stopTimer(state.errorTimers, peerId); // the relay link reaches the peer after all: a held join error is dropped
        if (state.paths.has(peerId) || state.graceTimers.has(peerId)) return;
        state.graceTimers.set(
            peerId,
            // Any join cancels this timer, so when it fires WebRTC did not join the peer in time.
            globalThis.setTimeout(() => {
                state.graceTimers.delete(peerId);
                join(state, peerId, 'relay');
            }, RELAY_GRACE_MS),
        );
    });
    relay?.onPeerLeave((peerId) => {
        state.relayUp.delete(peerId);
        stopTimer(state.graceTimers, peerId);
        lose(state, peerId, 'relay');
    });
    relay?.onMessage((peerId, message) => deliver(state, peerId, message, 'relay'));
};

const sendTo = (state: HybridState, message: unknown, target: string | undefined): Promise<void> => {
    const { direct, relay } = state;
    const path = target === undefined ? undefined : state.paths.get(target);
    if (target === undefined || path === undefined) return Promise.reject(new Error('That peer is not connected.'));
    // A peer's path is never `relay` without a relay link: only its events join a peer there.
    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
    return (path === 'direct' ? direct : (relay as RemoteTransport)).send(message, target);
};

export const createHybridTransport = ({ direct, relay }: HybridOptions): RemoteTransport => {
    const state: HybridState = {
        direct,
        relay,
        paths: new Map(),
        directUp: new Set(),
        relayUp: new Set(),
        graceTimers: new Map(),
        errorTimers: new Map(),
        messageHandlers: new Set(),
        joinHandlers: new Set(),
        leaveHandlers: new Set(),
        errorHandlers: new Set(),
    };
    wireDirect(state);
    wireRelay(state);

    return {
        send: (message, target) => sendTo(state, message, target),
        onMessage: handlerSet(state.messageHandlers),
        onPeerJoin: handlerSet(state.joinHandlers),
        onPeerLeave: handlerSet(state.leaveHandlers),
        onJoinError: handlerSet(state.errorHandlers),
        leave: async () => {
            for (const timers of [state.graceTimers, state.errorTimers]) {
                for (const peerId of timers.keys()) stopTimer(timers, peerId);
            }
            await Promise.all([relay?.leave(), direct.leave()]);
        },
        peerPath: (peerId) => state.paths.get(peerId) ?? null,
        relayAvailable: () => relay !== null,
    };
};
