/**
 * Small one-off IPC handlers: open-external-url, reload-window and
 * refresh-menu. The remote-access pairing channels come from
 * remote/remote.handlers.ts (the store itself lives in remote/pairing.ts and
 * arrives injected, so tests build the handlers without it) and are spread
 * into the map below.
 */

import { shell } from 'electron';
import { errorResult } from '../../core/ipc/errorResult';
import * as logger from '../../core/logger';
import { updateMenuTranslations } from './ui/applicationMenu';
import { translationManager } from '../../core/translations/index';
import { isSafeExternalUrl } from '../../core/format/urlSafe';
import { buildRemoteAccessHandlers } from './remote/remote.handlers';

import type { BrowserWindow } from 'electron';
import type { IpcHandlerMap } from '../../core/ipc/invokeHandler';
import type { RemotePairing } from './remote/pairing';

interface MiscHandlerDeps {
    getMainWindow: () => BrowserWindow | null;
    getLoginWindow: () => BrowserWindow | null;
    /** The desktop's pairing store (shells/electron/remote/pairing.ts). */
    remote: Pick<RemotePairing, 'accessInfo' | 'setEnabled' | 'resetKey'>;
}

const buildHandlers = (deps: MiscHandlerDeps) => {
    const { getMainWindow, getLoginWindow } = deps;

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

        // The remote-access pairing channels: the handlers live in
        // remote/remote.handlers.ts, over the injected pairing store.
        ...buildRemoteAccessHandlers(deps),
    } satisfies IpcHandlerMap;
};

export { buildHandlers };
