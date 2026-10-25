/**
 * Auth helpers shared between IPC handlers that need an early-return
 * when the user is not logged in.
 *
 * Intentionally small: only the token-presence check is shared. Each
 * handler keeps its own success-path logging, sanitisation, and error
 * formatting because those are not the same between the turbo and
 * boost flows.
 */

import { LOGOUT_NOT_SAVED } from '../ipc/logoutCode';
import * as settings from '../settings';
import * as logger from '../logger';
import { clearOpenChallenges } from './openChallengeCache';
import { clearUpcomingCache } from './discoverChallenges';
import { clearLibraryCache } from './libraryCache';
import { forgetChosenPhotosMemory } from './autoFill/chosenPhotos';

import type { ConfigV2 } from '../types/config';

/**
 * A raw authentication response: every token key and error field GuruShots
 * has been seen to return across versions.
 */
interface RawAuthResponse {
    token?: string;
    access_token?: string;
    auth_token?: string;
    error?: string;
    message?: string;
}

/**
 * Loads settings and verifies a token is present. On miss, logs a
 * warning under the authentication category and returns an
 * early-return response that the IPC handler can pass straight back
 * to the renderer.
 *
 * @param actionLabel - free-text action identifier used only
 *   in the warning log message (e.g. 'turbo apply', 'boost').
 */
const requireAuthToken = (
    actionLabel: string,
): { ok: true; token: string; settings: ConfigV2 } | { ok: false; response: { success: false; error: string } } => {
    const userSettings = settings.loadSettings();
    if (!userSettings.auth.token) {
        logger.withCategory('authentication').warning(`❌ No token found for ${actionLabel}`, null);
        return {
            ok: false,
            response: { success: false, error: 'No authentication token found' },
        };
    }
    return { ok: true, token: userSettings.auth.token, settings: userSettings };
};

/**
 * Normalize a raw authentication response into a single success/token/error
 * shape, accepting every token key and success indicator GuruShots has been
 * seen to return across versions. This is the one place that knows the wire
 * shape — both BaseMiddleware._login (CLI + GUI) and the authenticate IPC
 * handler call it, so the CLI and GUI agree on what "logged in" means.
 *
 * Success requires an actual token: a bare `success: true` / `status:
 * 'success'` without a token still resolves to a failure (there is nothing to
 * persist).
 *
 * @param response - Raw response from apiStrategy.authenticate.
 */
const extractAuthResult = (
    response: RawAuthResponse | null | undefined,
): { ok: true; token: string; error: null } | { ok: false; token: null; error: string } => {
    if (!response) {
        return { ok: false, token: null, error: 'Authentication failed - no response from server' };
    }
    // The only thing that makes a response successful is an actual token under
    // any of the keys GuruShots has been seen to use; a bare `success: true` /
    // `status: 'success'` without a token still fails (nothing to persist).
    // Trim so a whitespace-only token is never persisted as if it were valid.
    const token = (response.token || response.access_token || response.auth_token || '').trim() || null;
    if (token) {
        return { ok: true, token, error: null };
    }
    return {
        ok: false,
        token: null,
        error: response.error || response.message || 'Authentication failed - invalid response from server',
    };
};

/**
 * What the process remembered about the account that left must not carry over to the next: its
 * listed challenges and the cached upcoming list, its photo-library listings, the open- and
 * upcoming-id lists cleanup spares chosen lists for, and the chosen-photo walk memos and explained
 * skips.
 */
const forgetAccountMemory = (): void => {
    clearOpenChallenges();
    clearUpcomingCache();
    clearLibraryCache();
    settings.forgetOpenChallengeIds();
    forgetChosenPhotosMemory();
};

/** A logout the settings refused: the sign-out was not saved, so the user is still logged in. */
class LogoutNotSavedError extends Error {
    constructor() {
        super(LOGOUT_NOT_SAVED);
        this.name = 'LogoutNotSavedError';
    }
}

/**
 * Core logout shared by every shell (Electron main, CLI, Capacitor bridge,
 * BaseMiddleware): clear the token and make sure the cleared value is
 * DURABLY persisted before resolving. The flush await is the load-bearing
 * part on Capacitor — settings writes go through a write-behind cache to
 * @capacitor/preferences, so without it an OS kill right after logout can
 * leave the old token persisted and silently restore the session on next
 * launch. On Electron/CLI the write is synchronous and the flush no-ops.
 *
 * Shell-specific behavior (window teardown, event emission, logging
 * wording) stays with each caller. A logout also returns the mode to the
 * environment default: the reset is queued in the same durable write as the
 * cleared token — the one flush covers both — and only when the save held,
 * so a refused logout leaves everything as it is.
 *
 * @returns true when a token was actually cleared.
 * @throws when the sign-out could not be saved (the settings refuse the write): a logout that did not hold is reported,
 *   never taken for one. (One made while the stored settings have not been read yet is refused like any save then, and
 *   reported the same way.)
 */
const clearAuthToken = async (): Promise<boolean> => {
    const hadToken = !!settings.getSetting('token');
    const saved = settings.setSetting('token', '');
    // A refused sign-out leaves the user logged in: what is remembered about the account stays.
    if (saved) {
        forgetAccountMemory();
        // Order is load-bearing: the mock reset must be QUEUED BEFORE the flush —
        // on Capacitor the flush is the only thing that makes a write-behind write
        // durable, so a reset placed after it would never survive an OS kill.
        // The reset's own false return is ignored on purpose: the token clear already held, and that is what matters.
        settings.setSetting('mock', settings.getEnvironmentInfo().defaultMock);
    }
    await settings.flushPendingWrites();
    if (!saved) throw new LogoutNotSavedError();
    return hadToken;
};

/**
 * Store the token a login just obtained. When it differs from the one stored, the account may have
 * changed without a logout in between (a login on top of another session), so what was remembered
 * about the previous one is dropped exactly as a logout would.
 *
 * @returns false when the token was not saved (the settings refused the write): the session then does not outlive
 *   this run, and the stored account is unchanged
 */
const switchAccountToken = (token: string): boolean => {
    const previous = settings.getSetting('token');
    if (!settings.setSetting('token', token)) return false;
    if (previous !== token) forgetAccountMemory();
    return true;
};

/**
 * Apply the `stayLoggedIn` preference at shutdown: with it off, the token must not survive
 * the process exiting.
 *
 * Lives here rather than in windows/lifecycle.ts because it is not an Electron rule — it was
 * only ever implemented there, so the CLI and Android kept a token on disk indefinitely even
 * with the setting off, quietly contradicting what the setting promises. The Electron path
 * keeps its own single-instance gate around this (a second instance quitting must not clear
 * the running one's token); that gate is genuinely Electron-specific and stays there.
 *
 * @returns true when a token was actually cleared.
 */
const clearTokenUnlessStayingLoggedIn = async (): Promise<boolean> => {
    if (settings.getSetting('stayLoggedIn')) return false;
    if (!settings.getSetting('token')) return false;
    return clearAuthToken();
};

export {
    requireAuthToken,
    extractAuthResult,
    clearAuthToken,
    switchAccountToken,
    clearTokenUnlessStayingLoggedIn,
    LogoutNotSavedError,
};
