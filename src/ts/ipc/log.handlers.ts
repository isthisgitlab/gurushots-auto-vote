/**
 * IPC handlers for the log channel.
 *
 * Two surfaces live here:
 *   1. one-shot writes (log-debug/info/warning/error/api, get-*-log-file)
 *   2. live log streaming to renderer windows (start/stop-log-stream)
 *      + backlog replay (get-log-backlog) so the Logs page shows entries
 *      that landed before the page mounted.
 *
 * The streaming side stashes a fan-out function on `global.sendLogToGUI`
 * which `logger.ts` calls when a log line is emitted.
 */

import * as logger from '../logger';
import { registerHandlers } from './registerHandlers';
import { errorResult } from './errorResult';

import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { IpcHandlerMap } from './registerHandlers';
import type { GuiLogEntry, GuiLogSink } from '../logger';

// Longest message a renderer log call may write; a compromised window cannot push more into the log files.
const MAX_LOG_MESSAGE_LENGTH = 8 * 1024;

// Longest serialized `data` a renderer log call may attach; a longer one is replaced by a marker.
const MAX_LOG_DATA_LENGTH = 16 * 1024;

// A renderer-supplied message as one bounded line.
const clip = (message: unknown): string => logger.sanitizeLogString(message, MAX_LOG_MESSAGE_LENGTH);

// Renderer-supplied `data` as it is, or a marker when its serialized form is over the cap (or cannot be serialized).
const clipData = (data: unknown): unknown => {
    let length: number;
    try {
        length = JSON.stringify(data)?.length ?? 0;
    } catch {
        return '[data omitted: it could not be serialized]';
    }
    return length > MAX_LOG_DATA_LENGTH
        ? `[data omitted: ${length} characters, over the ${MAX_LOG_DATA_LENGTH} limit]`
        : data;
};

const logStreamWindows: Set<WebContents> = new Set();

// logger.ts calls this with a full entry object: { seq, level, context,
// category, timestamp, message }. We forward as-is to renderers.
const sendLogToGUI = (entry: GuiLogEntry) => {
    logStreamWindows.forEach((webContents) => {
        if (!webContents.isDestroyed()) {
            webContents.send('log-message', entry);
        }
    });
};

const buildHandlers = () =>
    ({
        'log-debug': async (event: unknown, message: string, data: unknown) => {
            logger.setContext('GUI');
            logger.withCategory('ui').debug(clip(message), clipData(data));
            logger.clearContext();
            return { success: true as const };
        },

        'log-error': async (event: unknown, message: string, data: unknown) => {
            logger.setContext('GUI');
            logger.withCategory('ui').error(clip(message), clipData(data));
            logger.clearContext();
            return { success: true as const };
        },

        'log-warning': async (event: unknown, message: string, data: unknown) => {
            logger.setContext('GUI');
            logger.withCategory('ui').warning(clip(message), clipData(data));
            logger.clearContext();
            return { success: true as const };
        },

        'log-api': async (event: unknown, message: string, data: unknown) => {
            logger.setContext('GUI');
            logger.withCategory('api').api(clip(message), clipData(data));
            logger.clearContext();
            return { success: true as const };
        },

        'get-log-file': async () => logger.getLogFile(),
        'get-error-log-file': async () => logger.getErrorLogFile(),
        'get-api-log-file': async () => logger.getApiLogFile(),

        'get-log-backlog': async () => logger.getRecentLogs(),

        'start-log-stream': async (event: IpcMainInvokeEvent | null | undefined) => {
            try {
                // Capacitor passes no IPC event (single-process WebView): there
                // is no webContents to register. Delivery is handled by the
                // bridge wiring globalThis.sendLogToGUI → in-process emitter, so
                // just acknowledge and let the renderer fetch its backlog.
                if (!event?.sender) return { success: true as const };
                logStreamWindows.add(event.sender);
                event.sender.on('destroyed', () => {
                    logStreamWindows.delete(event.sender);
                });
                return { success: true as const };
            } catch (error) {
                logger.withCategory('ui').error('Error starting log stream:', error);
                return errorResult(error, 'Failed to start log stream');
            }
        },

        'stop-log-stream': async (event: IpcMainInvokeEvent | null | undefined) => {
            try {
                if (event?.sender) logStreamWindows.delete(event.sender);
                return { success: true as const };
            } catch (error) {
                logger.withCategory('ui').error('Error stopping log stream:', error);
                return errorResult(error, 'Failed to stop log stream');
            }
        },
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => {
    registerHandlers(ipcMain, buildHandlers());
    // logger.ts looks up this function via the global to push log
    // events from any module without a back-reference.
    (global as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = sendLogToGUI;
};

export { register, buildHandlers, sendLogToGUI };
