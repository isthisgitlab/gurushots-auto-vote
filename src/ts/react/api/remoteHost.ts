/**
 * The remote-access host: the desktop main window's renderer side of the
 * pairing. While the feature is enabled it joins the pairing room (through the
 * injected transport factory — the trystero adapter in production), answers
 * paired phones' `hello` with the app version and a snapshot, forwards their
 * invokes through the allowlist dispatch to `window.api`, relays the desktop's
 * events and the autovote controller's state, and owns the desktop's one log
 * stream while at least one phone wants it. This module is the family's
 * public surface; the implementation lives in the `remoteHost*.ts` siblings.
 *
 * The family is the only remote code allowed to touch `window.api` (it lives
 * in `react/api/`). The pairing key and link never reach it — the caller hands
 * the room `key` only to the transport factory — and nothing here ever logs
 * the key, the link, or an invoke's arguments.
 *
 * The one timer stays one: `autovote-command` runs on the caller's own
 * controller, never on a second one built here.
 */

export { appVersion, createRemoteHost, MAX_REMOTE_PEERS } from './remoteHostCreate';
export type { RemoteHostDeps } from './remoteHostCreate';

export {
    pushAutovoteStateToActiveHost,
    remoteConnectionCount,
    remoteRelayCount,
    setActiveRemoteHost,
    subscribeRemoteConnectionCount,
} from './remoteHostBadge';

export { useDesktopRemoteHost } from './remoteHostHook';
