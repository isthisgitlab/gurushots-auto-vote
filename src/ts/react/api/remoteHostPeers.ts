/**
 * The remote host's shared room state and the plumbing every answer and every
 * dispatch goes through: the send that swallows a phone vanishing mid-flight,
 * the desktop log stream's release, and the peer bookkeeping that drives the
 * connected count.
 */

import { MAX_PEER_FIELD_LENGTH } from '../../core/remote/protocol';

import type { RemoteTransport } from '../../core/remote/relays';
import type { RemoteHostDeps } from './remoteHostCreate';

/** What the host's helpers share: the deps, the room transport, and the peers. */
export type HostContext = {
    deps: RemoteHostDeps;
    /** The room transport while the host is in the room; null when it is not. */
    transport: RemoteTransport | null;
    /** The peers that said hello with a matching version — the only ones anything is sent to. */
    readonly peers: Set<string>;
    /** The peer ids the desktop has already shown "A phone connected" for in this host session: a phone that drops and returns (a background tab) does not notify again. */
    readonly notified: Set<string>;
    /** The subset of peers that want the log stream. */
    readonly logPeers: Set<string>;
    /** The connected-count listeners (the header badge). */
    readonly countListeners: Set<() => void>;
};

/** A peer id clipped for a log line: ids are bounded like every other logged field. */
export const clippedId = (value: string): string => value.slice(0, MAX_PEER_FIELD_LENGTH);

/** Announces a connected-count change to the listeners (the header badge). */
export const notifyCount = (ctx: HostContext): void => {
    for (const listener of ctx.countListeners) listener();
};

export const sendTo = async (ctx: HostContext, peerId: string, message: unknown): Promise<void> => {
    const transport = ctx.transport;
    if (transport === null) return;
    try {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        await transport.send(message, peerId);
    } catch {
        // A send to a phone that went away mid-flight fails; its leave has been or will be
        // announced separately, so the failure itself is nothing to log.
    }
};

/** Ends the desktop's one log stream. A failure is nobody's to answer: the stream ends with the window anyway. */
export const releaseLogStream = async (ctx: HostContext): Promise<void> => {
    try {
        await ctx.deps.invoke('stop-log-stream', []);
    } catch {
        // see above
    }
};

export const dropPeer = (ctx: HostContext, peerId: string): void => {
    if (!ctx.peers.delete(peerId)) return;
    if (ctx.logPeers.delete(peerId) && ctx.logPeers.size === 0) void releaseLogStream(ctx);
    ctx.deps.logInfo(`Remote peer left: ${clippedId(peerId)}`);
    notifyCount(ctx);
};
