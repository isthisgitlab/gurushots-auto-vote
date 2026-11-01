/**
 * Small one-off IPC handlers: open-external-url, reload-window,
 * refresh-menu, and the remote-access pairing channels (the store itself
 * lives in remote/pairing.ts and arrives injected, so tests build the
 * handlers without it).
 */

import { shell } from 'electron';
import { errorResult } from '../../core/ipc/errorResult';
import * as logger from '../../core/logger';
import { updateMenuTranslations } from './ui/applicationMenu';
import { translationManager } from '../../core/translations/index';
import { isSafeExternalUrl } from '../../core/format/urlSafe';

import type { BrowserWindow } from 'electron';
import type { IpcHandlerMap } from '../../core/ipc/invokeHandler';
import type { RemotePairing } from './remote/pairing';

// Longest message the remote-access host may write in one line.
const MAX_REMOTE_LOG_LENGTH = 1024;

interface MiscHandlerDeps {
    getMainWindow: () => BrowserWindow | null;
    getLoginWindow: () => BrowserWindow | null;
    /** The desktop's pairing store (shells/electron/remote/pairing.ts). */
    remote: Pick<RemotePairing, 'accessInfo' | 'setEnabled' | 'resetKey'>;
}

const buildHandlers = (deps: MiscHandlerDeps) => {
    const { getMainWindow, getLoginWindow, remote } = deps;

    return {
        'open-external-url': async (event: unknown, url: string) => {
            try {
                // Scheme allow-list (shared with the Capacitor bridge via
                // format/urlSafe): every legitimate call site opens an https
                // page (gurushots.com, GitHub releases, the donatr.ee donation
                // page). Refusing anything else keeps this from ever becoming
                // an open-any-scheme primitive (file:, shell handlers, ...).
                if (!isSafeExternalUrl(url)) {
                    logger.withCategory('api').warning(`Refused open-external-url for non-https URL: ${url}`, null);
                    return { success: false as const, error: 'Only https:// URLs can be opened' };
                }
                await shell.openExternal(url);
                return { success: true as const };
            } catch (error) {
                logger.withCategory('ui').error('Error opening external URL:', error);
                return errorResult(error, 'Failed to open external URL');
            }
        },

        'reload-window': async () => {
            try {
                const mainWindow = getMainWindow();
                const loginWindow = getLoginWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.reload();
                    return { success: true as const };
                }
                if (loginWindow && !loginWindow.isDestroyed()) {
                    loginWindow.reload();
                    return { success: true as const };
                }
                return { success: false as const, error: 'No active window to reload' };
            } catch (error) {
                logger.withCategory('ui').error('Error reloading window:', error);
                return errorResult(error, 'Failed to reload window');
            }
        },

        'refresh-menu': async () => {
            try {
                // Adopt the saved language in the main-process translator,
                // then rebuild the menu so its labels reflect it.
                await translationManager.loadLanguageFromSettings();
                updateMenuTranslations();
                return { success: true as const };
            } catch (error) {
                logger.withCategory('ui').error('Error refreshing menu:', error);
                return errorResult(error, 'Failed to refresh menu');
            }
        },

        // The remote-access pairing channels. The link and QR code carry the pairing key, so
        // neither is ever logged and the answers go only to the window that asked.
        'get-remote-access': async () => {
            try {
                return { success: true as const, ...remote.accessInfo() };
            } catch (error) {
                logger.withCategory('ui').error('Error reading remote access state:', error);
                return errorResult(error, 'Failed to read the remote access state');
            }
        },

        'set-remote-access': async (_event: unknown, enabled: boolean) => {
            try {
                if (typeof enabled !== 'boolean') {
                    return { success: false as const, error: 'Enabled must be a boolean' };
                }
                return { success: remote.setEnabled(enabled) };
            } catch (error) {
                logger.withCategory('ui').error('Error setting remote access:', error);
                return errorResult(error, 'Failed to change remote access');
            }
        },

        // The host's INFO line: a packaged build writes no DEBUG lines, and remote activity must show in the log files.
        // The host sends channel names and counts only, never arguments or the key.
        'log-remote-info': async (_event: unknown, message: string) => {
            if (typeof message !== 'string') return { success: false as const, error: 'The message must be a string' };
            logger.setContext('GUI');
            logger.withCategory('ui').info(logger.sanitizeLogString(message, MAX_REMOTE_LOG_LENGTH));
            logger.clearContext();
            return { success: true as const };
        },

        'reset-remote-pairing': async () => {
            try {
                return { success: remote.resetKey() !== null };
            } catch (error) {
                logger.withCategory('ui').error('Error resetting the remote pairing key:', error);
                return errorResult(error, 'Failed to reset the pairing key');
            }
        },
    } satisfies IpcHandlerMap;
};

export { buildHandlers };
