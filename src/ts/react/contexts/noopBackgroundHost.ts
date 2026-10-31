import type { BackgroundHost } from '../../core/autovote/controller';

/**
 * A background host that does nothing: Electron and the web shell have no
 * native service to hand scheduling to, but the controller's host needs one
 * in every bundle — and this module must never pull the Capacitor bridges
 * into their graphs.
 */
export const noopBackgroundHost: BackgroundHost = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    update: () => Promise.resolve(),
    status: () => Promise.resolve({ running: false, available: false }),
};
