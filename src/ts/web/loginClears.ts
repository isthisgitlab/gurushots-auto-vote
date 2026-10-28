/**
 * The web shell's two stay-logged-in token clears: a leftover a previous run left behind is
 * cleared before the server listens, and the token this run leaves behind is cleared in the
 * close chain before the process exits. Both gates are the same discipline — never clear a
 * login a sibling shell may be using, and never throw.
 */

import { clearTokenUnlessStayingLoggedIn } from '../services/auth';
import * as settings from '../settings';
import { isCliSessionActive, isDesktopAppActive, isWebServerActive } from '../settings/cliSessionLock';
import * as logger from '../logger';

// One string for both clears: they keep the login for the same reason — a sibling shell that is
// running may be using it.
const SIBLING_KEEP_LOGIN =
    'Kept the saved login token because another session is running and may be using it (CLI, desktop app, or web server)';

/** Whether another process holds any sibling shell's marker; the three checks run together, so a stale-but-live marker costs one settle wait, not three. */
const anySiblingShellActive = (): Promise<boolean> =>
    Promise.all([isCliSessionActive(), isDesktopAppActive(), isWebServerActive()]).then((states) =>
        states.some(Boolean),
    );

/**
 * A login a run left behind (a crash or a kill skips the close-time clear) is cleared before the
 * server listens, so no page can observe a pre-clear token — unless "Stay Logged In" is on. A
 * sibling shell that is running may be using the login, so it is left alone then, and a login made
 * while the marker checks settle is never cleared either (the token is read again first). Never
 * throws: a refused clear is logged, never fatal.
 */
const clearLeftoverToken = async (): Promise<void> => {
    try {
        const leftover = settings.getSetting('token');
        if (settings.getSetting('stayLoggedIn') || !leftover) return;
        logger.printLine('Attempting to clear the saved login before starting…');
        if (await anySiblingShellActive()) {
            logger.withCategory('authentication').info(SIBLING_KEEP_LOGIN, null);
            return;
        }
        if (settings.getSetting('token') !== leftover || settings.getSetting('stayLoggedIn')) return;
        if (await clearTokenUnlessStayingLoggedIn()) {
            logger
                .withCategory('authentication')
                .info('Cleared a saved token left by an earlier run (Stay Logged In is off)', null);
        }
    } catch (error) {
        logger.withCategory('authentication').error('Failed to clear a leftover token at startup:', error);
    }
};

/**
 * The close chain's clear: with Stay Logged In off, the token this run leaves behind is cleared
 * before the process exits — the same gated clear the launch runs, with the stop path's own
 * wording. A wipe stop says nothing here: the wiped store reads no token, so the gate skips
 * silently, and a store the wipe discarded must not be reported as a failed clear either.
 */
const clearTokenBeforeExit = async (wiped: () => boolean): Promise<void> => {
    try {
        const saved = settings.getSetting('token');
        if (settings.getSetting('stayLoggedIn') || !saved) return;
        logger.printLine('Attempting to clear the saved login before exiting…');
        if (await anySiblingShellActive()) {
            logger.withCategory('authentication').info(SIBLING_KEEP_LOGIN, null);
            return;
        }
        if (settings.getSetting('token') !== saved || settings.getSetting('stayLoggedIn')) return;
        if (await clearTokenUnlessStayingLoggedIn()) {
            logger.withCategory('authentication').info('Cleared saved token (Stay Logged In is off)', null);
        }
    } catch (error) {
        if (!wiped()) logger.withCategory('authentication').error('Failed to clear token on shutdown', error);
    }
};

export { clearLeftoverToken, clearTokenBeforeExit };
