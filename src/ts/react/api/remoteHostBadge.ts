/**
 * The connected-count of the running remote host, as an external store for the
 * header badge. The host instance registers itself (`setActiveRemoteHost`);
 * without one (remote access off, or not the desktop) the count answers zero
 * and the badge hides.
 */

import type { AutovoteState } from '../../core/autovote/state';
import type { RemoteHost } from './remoteHostCreate';

let activeHost: RemoteHost | null = null;
let activeHostUnsub: (() => void) | null = null;
const badgeListeners = new Set<() => void>();

const badgeNotify = (): void => {
    for (const listener of badgeListeners) listener();
};

/** Registers a host as the running one (or clears the registration with null). */
export const setActiveRemoteHost = (host: RemoteHost | null): void => {
    activeHostUnsub?.();
    activeHostUnsub = null;
    activeHost = host;
    if (host !== null) activeHostUnsub = host.onCountChange(badgeNotify);
    badgeNotify();
};

/** Subscribes to remote-host count changes for non-React consumers; answers the unsubscribe. */
export const subscribeRemoteConnectionCount = (listener: () => void): (() => void) => {
    badgeListeners.add(listener);
    return () => badgeListeners.delete(listener);
};

/** The connected-phone count the badge shows; 0 when no host runs. */
export const remoteConnectionCount = (): number => (activeHost === null ? 0 : activeHost.connectedCount());

/** Relays the controller's state to the paired phones through the running host, if any. */
export const pushAutovoteStateToActiveHost = (state: AutovoteState): void => {
    activeHost?.pushAutovoteState(state);
};
