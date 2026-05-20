/**
 * CLI `logs` command. Prints the tail of one of the on-disk log files so CLI
 * users get the after-the-fact log access the Electron Logs page provides.
 * The logger owns the file paths; this command only reads and tails them.
 */

const fs = require('fs');
const logger = require('../../logger');

// category flag → logger path getter. Defaults to the app log.
const LOG_FILE_GETTERS = {
    app: () => logger.getLogFile(),
    error: () => logger.getErrorLogFile(),
    api: () => logger.getApiLogFile(),
    settings: () => logger.getSettingsLogFile(),
};

const showLogs = ({ category = 'app', lines = 100 } = {}) => {
    const getPath = LOG_FILE_GETTERS[category] || LOG_FILE_GETTERS.app;
    const filePath = getPath();
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            logger.withCategory('ui').info(`No ${category} log file found yet.`);
            return;
        }
        const allLines = fs.readFileSync(filePath, 'utf8').split('\n');
        const tail = allLines.slice(-lines).join('\n');
        logger.withCategory('ui').info(`=== ${category} log (last ${lines} lines): ${filePath} ===`);
        logger.withCategory('ui').info(tail);
    } catch (error) {
        logger.withCategory('ui').error(`Error reading ${category} log`, error);
    }
};

module.exports = { showLogs };
