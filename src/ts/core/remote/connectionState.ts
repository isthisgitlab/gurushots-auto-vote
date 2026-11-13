/**
 * The phone's pairing connection state, as a tiny store: the peer bridge (shells/remote)
 * writes it, and the page's React components read it — react may not import a shell, so the
 * state lives here, in core. Dependency-free.
 *
 * The same module keeps the desktop's peer id (`setRemoteHostPeerId` / `remoteHostPeerId`):
 * the store and the reader live here, and its one writer is the phone's peer bridge
 * (`shells/remote/bridge/peer.ts`), which sets it on the first host `hello` and clears it
 * when the connection is lost. Only the path has listeners (`subscribeRemoteHostPath`): it can change in place.
 */

import type { RemotePath } from './relays';

export type RemoteConnectionState =
    /** joining the room, nothing heard from the desktop yet */
    | 'connecting'
    /** the desktop said hello with a matching version */
    | 'connected'
    /** the desktop is gone, or the link was reset */
    | 'offline'
    /** peers saw each other but WebRTC could not connect on this network, and the relays reached nobody */
    | 'network'
    /** like `network`, but this browser has no `CompressionStream`, so the relay fallback could not even run */
    | 'old-browser'
    /** the desktop is older than this current page */
    | 'update'
    /** the desktop is newer than this current page */
    | 'update-this'
    /** the desktop already has the most phones it takes */
    | 'full'
    /** the page was opened without a pairing key in its link */
    | 'no-key';

let current: RemoteConnectionState = 'connecting';
const listeners = new Set<(state: RemoteConnectionState) => void>();

/** Called by the peer bridge when the connection state changes. */
export const setRemoteConnectionState = (state: RemoteConnectionState): void => {
    if (current === state) return;
    current = state;
    for (const listener of listeners) listener(state);
};

/** The current connection state. */
export const remoteConnectionState = (): RemoteConnectionState => current;

/** Subscribes to connection-state changes; answers the unsubscribe. */
export const subscribeRemoteConnectionState = (listener: (state: RemoteConnectionState) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

let hostPeerId: string | null = null;

/** The peer id of the desktop, as its `hello` named it. The phone's peer bridge writes it: set on the first host hello, cleared when the connection is lost. */
export const setRemoteHostPeerId = (peerId: string | null): void => {
    hostPeerId = peerId;
};

/** The peer id of the connected desktop, or null while no desktop is connected. */
export const remoteHostPeerId = (): string | null => hostPeerId;

let hostPath: RemotePath = 'direct';
const pathListeners = new Set<(path: RemotePath) => void>();

/**
 * Which path the connected desktop is reached over. The peer bridge writes it just before it reads `connected`,
 * and again when the transport moves the desktop to another path in place (the relay to WebRTC).
 */
export const setRemoteHostPath = (path: RemotePath): void => {
    if (hostPath === path) return;
    hostPath = path;
    for (const listener of pathListeners) listener(path);
};

/** Subscribes to changes of the desktop's path; answers the unsubscribe. */
export const subscribeRemoteHostPath = (listener: (path: RemotePath) => void): (() => void) => {
    pathListeners.add(listener);
    return () => pathListeners.delete(listener);
};

/** The path the connected desktop is reached over (`direct` until a desktop has connected). */
export const remoteHostPath = (): RemotePath => hostPath;
