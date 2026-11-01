/**
 * The phone's pairing connection state, as a tiny store: the peer bridge (shells/remote)
 * writes it, and the page's React components read it — react may not import a shell, so the
 * state lives here, in core. Dependency-free.
 */

export type RemoteConnectionState =
    /** joining the room, nothing heard from the desktop yet */
    | 'connecting'
    /** the desktop said hello with a matching version */
    | 'connected'
    /** the desktop is gone, or the link was reset */
    | 'offline'
    /** peers saw each other but WebRTC could not connect on this network */
    | 'network'
    /** the desktop runs an older app version than this page */
    | 'update'
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
