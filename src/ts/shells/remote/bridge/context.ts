/**
 * The peer bridge's shared mutable state, in one context object: the sibling modules of
 * bridge/ read and write it, and the composer (peer.ts) builds it once per install.
 * Loaded only by the remote renderer entries, so it stays free of Node-side modules.
 */

import type { RemoteTransport } from '../../../core/remote/relays';

type PendingInvoke = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    spend: boolean;
};

export type Listener = (payload: unknown) => void;

/**
 * The bridge's shared state. `hostPeerId` is the desktop's peer id once its hello named it —
 * null before, and after a loss. `everConnected` says whether the desktop has ever completed a
 * hello in this page's life: only before that first connect may a non-spend invoke be held;
 * after a loss nothing queues.
 */
export type PeerBridgeContext = {
    readonly transport: RemoteTransport;
    readonly pending: Map<number, PendingInvoke>;
    readonly heldSends: Array<{ id: number; message: object }>;
    readonly listeners: Map<string, Set<Listener>>;
    /** The peers seen and not yet known to be the desktop or gone: any of them may still answer. */
    readonly waiting: Set<string>;
    /** The peers that announced themselves as fellow phones. */
    readonly phones: Set<string>;
    hostPeerId: string | null;
    everConnected: boolean;
    /** The timer that reads the desktop absent when none joins in time; one at a time. */
    offlineWait: ReturnType<typeof setTimeout> | null;
};

export const createPeerBridgeContext = (transport: RemoteTransport): PeerBridgeContext => ({
    transport,
    pending: new Map(),
    heldSends: [],
    listeners: new Map(),
    waiting: new Set(),
    phones: new Set(),
    hostPeerId: null,
    everConnected: false,
    offlineWait: null,
});
