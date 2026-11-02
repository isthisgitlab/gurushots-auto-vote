/**
 * The peer bridge's connection state machine: which peer counts as the desktop (peer
 * join, leave, join failure), when a loss settles the pending invokes, and the wait that
 * reads the desktop absent when nobody answers in time. The state itself lives in
 * core/remote/connectionState.ts, where the page's React reads it. Loaded only by the
 * remote renderer entries, so it stays free of Node-side modules.
 */

import {
    remoteConnectionState,
    setRemoteConnectionState,
    setRemoteHostPeerId,
} from '../../../core/remote/connectionState';
import { HOST_ANSWER_TIMEOUT_MS } from '../../../core/remote/helloRepeat';
import { isConnectionFailureJoinError } from '../../../core/remote/trystero';

import type { HelloRepeater } from '../../../core/remote/helloRepeat';
import type { PeerBridgeContext } from './context';
import type { InvokePipeline } from './invokes';

export type ConnectionWatch = {
    readonly ctx: PeerBridgeContext;
    readonly hello: HelloRepeater;
    readonly pipeline: InvokePipeline;
};

export type ConnectionWatchApi = {
    /** Settles every pending invoke once and reads offline — the bye path drives this too. */
    readonly settlePendingForLostConnection: () => void;
    /** Settles every pending invoke once and reads connecting again, with the offline wait running; the desktop at `peerId` is asked to say hello. */
    readonly reconnect: (peerId: string) => void;
};

/**
 * Settle every pending invoke once — the connection is lost. A spend may have run: unclear, never a
 * failure. `next` is what the page reads afterwards: offline, or connecting while a rejoin is awaited.
 */
const settlePendingForLostConnection = (watch: ConnectionWatch, next: 'offline' | 'connecting' = 'offline'): void => {
    const { ctx, hello, pipeline } = watch;
    hello.stop();
    ctx.hostPeerId = null;
    setRemoteHostPeerId(null);
    for (const [, invoke] of ctx.pending) {
        if (invoke.spend) invoke.resolve(pipeline.lostSpendAnswer());
        else invoke.reject(pipeline.lostFailure());
    }
    ctx.pending.clear();
    ctx.heldSends.length = 0;
    setRemoteConnectionState(next);
};

/**
 * Whether this join failure ends the session. The leave path never calls this — the rule serves
 * the join-error path only; a leave of a peer that announced itself as a fellow phone is handled
 * on the leave path before any such rule is reached. A peer in `phones` never ends the session
 * either: its own join failure says nothing about the desktop's wait, like the loader's. A join
 * failure only ever names a peer that never joined, so the named peer is never in `waiting`;
 * before the desktop has answered, the failure ends the session only when no candidate is left —
 * that peer was the page's last hope.
 */
const endsSession = (watch: ConnectionWatch, peerId: string): boolean => {
    const { ctx, hello } = watch;
    hello.leave(peerId);
    ctx.waiting.delete(peerId);
    if (ctx.phones.has(peerId)) return false;
    return ctx.hostPeerId === null ? ctx.waiting.size === 0 : peerId === ctx.hostPeerId;
};

/**
 * Reads the desktop absent if none has joined (or rejoined) in time. Reading it absent does not stop
 * the page connecting later: at the first connect the hello repeat is still running, so a desktop that
 * answers late moves the page to connected; after a leave the repeat was stopped (the loss settle stops
 * it), and the desktop's next join starts it again. On the `reconnect` path the loss settle stops the repeat
 * too, and `hello.join` starts it again at once.
 */
const waitForDesktop = (watch: ConnectionWatch): void => {
    const { ctx } = watch;
    if (ctx.offlineWait !== null) globalThis.clearTimeout(ctx.offlineWait);
    ctx.offlineWait = globalThis.setTimeout(() => {
        ctx.offlineWait = null;
        if (ctx.hostPeerId === null && remoteConnectionState() === 'connecting') setRemoteConnectionState('offline');
    }, HOST_ANSWER_TIMEOUT_MS);
};

/** The desktop forgot this phone (it answered "say hello first"): what was in flight is settled, and the page asks to be taken back. */
const reconnect = (watch: ConnectionWatch, peerId: string): void => {
    settlePendingForLostConnection(watch, 'connecting');
    watch.ctx.waiting.add(peerId);
    watch.hello.join(peerId);
    waitForDesktop(watch);
};

const onPeerLeave = (watch: ConnectionWatch, peerId: string): void => {
    const { ctx, hello } = watch;
    // Only the desktop's own leave ends the session. Before the desktop has answered, the leave
    // of a peer that already announced itself as a fellow phone — or of a stranger that never
    // joined — ends nothing: the desktop may still connect.
    const fromTheDesktop = peerId === ctx.hostPeerId || (ctx.hostPeerId === null && ctx.waiting.has(peerId));
    hello.leave(peerId);
    ctx.waiting.delete(peerId);
    if (fromTheDesktop && (ctx.hostPeerId !== null || ctx.waiting.size === 0)) {
        // A phone tab in the background has its timers throttled, so the desktop can drop it for silence and
        // take it back a moment later: the page reads connecting, and offline only if no desktop returns in time.
        settlePendingForLostConnection(watch, 'connecting');
        waitForDesktop(watch);
    }
};

const onJoinError = (watch: ConnectionWatch, error: string, peerId: string): void => {
    // Only the "peers saw each other but WebRTC could not connect" error is the try-Wi-Fi
    // state, and only for a peer that can still be the desktop — a fellow phone's failed join
    // ends nothing at all (endsSession answers false for it). A wrong password or a handshake
    // failure looks like an offline-or-reset desktop.
    if (!endsSession(watch, peerId)) return;
    settlePendingForLostConnection(watch);
    // The hybrid transport forwards a join error only when the relays reached nobody either; a browser
    // that cannot run the relay fallback at all is told to update, not to try Wi-Fi.
    const relayRuns = watch.ctx.transport.relayAvailable?.() ?? true;
    setRemoteConnectionState(isConnectionFailureJoinError(error) ? (relayRuns ? 'network' : 'old-browser') : 'offline');
};

export const watchConnection = (watch: ConnectionWatch): ConnectionWatchApi => {
    const { ctx, hello } = watch;
    ctx.transport.onPeerJoin((peerId) => {
        ctx.waiting.add(peerId);
        hello.join(peerId);
    });
    ctx.transport.onPeerLeave((peerId) => onPeerLeave(watch, peerId));
    ctx.transport.onJoinError(({ error, peerId }) => onJoinError(watch, error, peerId));

    // Nobody answered in time: the desktop is offline (or the link was reset).
    waitForDesktop(watch);

    return {
        settlePendingForLostConnection: () => settlePendingForLostConnection(watch),
        reconnect: (peerId) => reconnect(watch, peerId),
    };
};
