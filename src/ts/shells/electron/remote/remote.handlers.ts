/**
 * The remote-access IPC handlers: the pairing channels over the desktop's
 * pairing store (remote/pairing.ts) and the host's INFO log line. The store
 * arrives injected, so tests build the handlers without it. misc.handlers
 * spreads this builder into its own handler map.
 */

import { errorResult } from '../../../core/ipc/errorResult';
import * as logger from '../../../core/logger';

import type { IpcHandlerMap } from '../../../core/ipc/invokeHandler';
import type { RemotePairing } from './pairing';

// Longest message the remote-access host may write in one line.
const MAX_REMOTE_LOG_LENGTH = 1024;

interface RemoteAccessHandlerDeps {
    /** The desktop's pairing store (shells/electron/remote/pairing.ts). */
    remote: Pick<RemotePairing, 'accessInfo' | 'setEnabled' | 'resetKey'>;
}

const buildRemoteAccessHandlers = (deps: RemoteAccessHandlerDeps) => {
    const { remote } = deps;

    return {
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

export { buildRemoteAccessHandlers };
