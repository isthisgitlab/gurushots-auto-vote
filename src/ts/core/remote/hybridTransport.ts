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

export const createHybridTransport = ({ direct, relay }: HybridOptions): RemoteTransport => {
    /** The joined peers and the path each was joined on. */
    const paths = new Map<string, RemotePath>();
    const directUp = new Set<string>();
    const relayUp = new Set<string>();
    const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const errorTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const messageHandlers = new Set<(peerId: string, message: unknown) => void>();
    const joinHandlers = new Set<(peerId: string) => void>();
    const leaveHandlers = new Set<(peerId: string) => void>();
    const errorHandlers = new Set<(details: JoinErrorDetails) => void>();

    const stopTimer = (timers: Map<string, ReturnType<typeof setTimeout>>, peerId: string): void => {
        const timer = timers.get(peerId);
        if (timer !== undefined) globalThis.clearTimeout(timer);
        timers.delete(peerId);
    };

    const join = (peerId: string, path: RemotePath): void => {
        stopTimer(graceTimers, peerId);
        stopTimer(errorTimers, peerId); // reachable after all: a held join error is dropped
        paths.set(peerId, path);
        for (const handler of joinHandlers) handler(peerId);
    };

    const leave = (peerId: string): void => {
        paths.delete(peerId);
        for (const handler of leaveHandlers) handler(peerId);
    };

    /** A peer's path ended; if the other path still reaches it, it joins on that one. */
    const lose = (peerId: string, path: RemotePath): void => {
        if (paths.get(peerId) !== path) return;
        leave(peerId);
        if ((path === 'direct' ? relayUp : directUp).has(peerId)) join(peerId, path === 'direct' ? 'relay' : 'direct');
    };

    /** A message from a peer not joined yet (a relay peer still in its grace period) is proof enough: it joins on the path it spoke on. */
    const deliver = (peerId: string, message: unknown, path: RemotePath): void => {
        if (!paths.has(peerId)) join(peerId, path);
        for (const handler of messageHandlers) handler(peerId, message);
    };

    direct.onPeerJoin((peerId) => {
        directUp.add(peerId);
        if (!paths.has(peerId)) join(peerId, 'direct');
    });
    direct.onPeerLeave((peerId) => {
        directUp.delete(peerId);
        lose(peerId, 'direct');
    });
    direct.onMessage((peerId, message) => deliver(peerId, message, 'direct'));
    direct.onJoinError((details) => {
        const { peerId } = details;
        if (graceTimers.has(peerId)) {
            // WebRTC gave up on a peer the relay link already reaches: no reason to wait out the grace period.
            join(peerId, 'relay');
            return;
        }
        if (paths.has(peerId) || relayUp.has(peerId)) return; // reachable another way: the failure is no news
        if (relay === null) {
            for (const handler of errorHandlers) handler(details);
            return;
        }
        if (errorTimers.has(peerId)) return;
        errorTimers.set(
            peerId,
            // A join (on either path) cancels this timer, so a held error that fires is for a peer nobody reached.
            globalThis.setTimeout(() => {
                errorTimers.delete(peerId);
                for (const handler of errorHandlers) handler(details);
            }, JOIN_ERROR_HOLD_MS),
        );
    });

    relay?.onPeerJoin((peerId) => {
        relayUp.add(peerId);
        stopTimer(errorTimers, peerId); // the relay link reaches the peer after all: a held join error is dropped
        if (paths.has(peerId) || graceTimers.has(peerId)) return;
        graceTimers.set(
            peerId,
            // Any join cancels this timer, so when it fires WebRTC did not join the peer in time.
            globalThis.setTimeout(() => {
                graceTimers.delete(peerId);
                join(peerId, 'relay');
            }, RELAY_GRACE_MS),
        );
    });
    relay?.onPeerLeave((peerId) => {
        relayUp.delete(peerId);
        stopTimer(graceTimers, peerId);
        lose(peerId, 'relay');
    });
    relay?.onMessage((peerId, message) => deliver(peerId, message, 'relay'));

    return {
        send: (message, target) => {
            const path = target === undefined ? undefined : paths.get(target);
            if (target === undefined || path === undefined)
                return Promise.reject(new Error('That peer is not connected.'));
            // A peer's path is never `relay` without a relay link: only its events join a peer there.
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
            return (path === 'direct' ? direct : (relay as RemoteTransport)).send(message, target);
        },
        onMessage: handlerSet(messageHandlers),
        onPeerJoin: handlerSet(joinHandlers),
        onPeerLeave: handlerSet(leaveHandlers),
        onJoinError: handlerSet(errorHandlers),
        leave: async () => {
            for (const timers of [graceTimers, errorTimers]) {
                for (const peerId of [...timers.keys()]) stopTimer(timers, peerId);
            }
            await Promise.all([relay?.leave(), direct.leave()]);
        },
        peerPath: (peerId) => paths.get(peerId) ?? null,
        relayAvailable: () => relay !== null,
    };
};
