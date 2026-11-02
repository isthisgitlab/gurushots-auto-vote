/**
 * What a phone page tells its peers when the browser moves it. A page that is going away for
 * good (`pagehide` with `persisted` false: a reload, a navigation, a closed tab) leaves the
 * transport, which sends a link `bye` on the relay path, so no ghost fills one of the desktop's
 * phone slots until its silence times out. A page the browser keeps in its back/forward cache
 * (`persisted`) is frozen, not gone: it is not left, and when it is restored (`pageshow` with
 * `persisted` true) the owner, when it passes a callback, says hello again, so a desktop that dropped it meanwhile takes it
 * back. The `bye` on `pagehide` is best effort: sealing and publishing it are asynchronous and the page may
 * be gone first, so the 25 s silence sweep of the desktop's relay link is the backstop. Dependency-free.
 */

import type { RemoteTransport } from './relays';

export const watchPageLifecycle = (transport: Pick<RemoteTransport, 'leave'>, onRestore?: () => void): void => {
    globalThis.addEventListener('pagehide', (event) => {
        if (!event.persisted) void transport.leave();
    });
    globalThis.addEventListener('pageshow', (event) => {
        if (event.persisted) onRestore?.();
    });
};
