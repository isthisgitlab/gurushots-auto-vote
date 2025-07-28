const fs = require('fs');
const path = require('path');

// Create logs directory in current directory
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create log file with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(logsDir, `api-debug-${timestamp}.log`);

// Logger function
const logToFile = (level, message, data = null) => {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] [${level}] ${message}`;
    
    if (data) {
        if (typeof data === 'object') {
            logEntry += '\n' + JSON.stringify(data, null, 2);
        } else {
            logEntry += '\n' + data;
        }
    }
    
    logEntry += '\n' + '='.repeat(80) + '\n';
    
    // Write to file
    fs.appendFileSync(logFile, logEntry);
    
    // Also log to console for immediate feedback
    console.log(`[${level}] ${message}`);
};

// Export logger functions
module.exports = {
    info: (message, data) => logToFile('INFO', message, data),
    error: (message, data) => logToFile('ERROR', message, data),
    api: (message, data) => logToFile('API', message, data),
    debug: (message, data) => logToFile('DEBUG', message, data),
    getLogFile: () => logFile,
}; 