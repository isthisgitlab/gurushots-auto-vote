/**
 * IPC handlers for the log channel.
 *
 * Two surfaces live here:
 *   1. one-shot writes (log-debug/error/api, get-*-log-file)
 *   2. live log streaming to renderer windows (start/stop-log-stream)
 *
 * The streaming side stashes a fan-out function on `global.sendLogToGUI`
 * which `logger.js` calls when a log line is emitted. That global was
 * already in place before this split — we keep it for compatibility.
 */

const logger = require('../logger');

const logStreamWindows = new Set();

const sendLogToGUI = (level, message, context, timestamp, category) => {
    const logData = { level, message, context, timestamp, category };
    logStreamWindows.forEach((webContents) => {
        if (!webContents.isDestroyed()) {
            webContents.send('log-message', logData);
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

    'log-api': async (event, message, data) => {
        logger.setContext('GUI');
        logger.withCategory('api').api(message, data);
        logger.clearContext();
        return { success: true };
    },

    'get-log-file': async () => logger.getLogFile(),
    'get-error-log-file': async () => logger.getErrorLogFile(),
    'get-api-log-file': async () => logger.getApiLogFile(),

    'start-log-stream': async (event) => {
        try {
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
            logStreamWindows.delete(event.sender);
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
