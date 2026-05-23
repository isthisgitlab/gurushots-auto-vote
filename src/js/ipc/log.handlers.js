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
 * which `logger.js` calls when a log line is emitted. That global was
 * already in place before this split — we keep it for compatibility.
 */

const logger = require('../logger');

const logStreamWindows = new Set();

// logger.js calls this with a full entry object: { seq, level, context,
// category, timestamp, message }. We forward as-is to renderers.
const sendLogToGUI = (entry) => {
    logStreamWindows.forEach((webContents) => {
        if (!webContents.isDestroyed()) {
            webContents.send('log-message', entry);
        }
    });
};

const buildHandlers = () => ({
    'log-debug': async (event, message, data) => {
        logger.setContext('GUI');
        logger.withCategory('ui').debug(message, data);
        logger.clearContext();
        return { success: true };
    },

    'log-error': async (event, message, data) => {
        logger.setContext('GUI');
        logger.withCategory('ui').error(message, data);
        logger.clearContext();
        return { success: true };
    },

    'log-warning': async (event, message, data) => {
        logger.setContext('GUI');
        logger.withCategory('ui').warning(message, data);
        logger.clearContext();
        return { success: true };
    },

    'log-api': async (event, message, data) => {
        logger.setContext('GUI');
        logger.withCategory('api').api(message, data);
        logger.clearContext();
        return { success: true };
    },

    'get-log-file': async () => logger.getLogFile(),
    'get-error-log-file': async () => logger.getErrorLogFile(),
    'get-api-log-file': async () => logger.getApiLogFile(),

    'get-log-backlog': async () => logger.getRecentLogs(),

    'start-log-stream': async (event) => {
        try {
            // Capacitor passes no IPC event (single-process WebView): there
            // is no webContents to register. Delivery is handled by the
            // bridge wiring globalThis.sendLogToGUI → in-process emitter, so
            // just acknowledge and let the renderer fetch its backlog.
            if (!event?.sender) return { success: true };
            logStreamWindows.add(event.sender);
            event.sender.on('destroyed', () => {
                logStreamWindows.delete(event.sender);
            });
            return { success: true };
        } catch (error) {
            logger.withCategory('ui').error('Error starting log stream:', error);
            return { success: false, error: error.message };
        }
    },

    'stop-log-stream': async (event) => {
        try {
            if (event?.sender) logStreamWindows.delete(event.sender);
            return { success: true };
        } catch (error) {
            logger.withCategory('ui').error('Error stopping log stream:', error);
            return { success: false, error: error.message };
        }
    },
});

const register = (ipcMain) => {
    const handlers = buildHandlers();
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, impl);
    }
    // logger.js looks up this function via the global to push log
    // events from any module without a back-reference.
    global.sendLogToGUI = sendLogToGUI;
};

module.exports = { register, buildHandlers, sendLogToGUI };
