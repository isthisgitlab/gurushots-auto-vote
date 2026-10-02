import * as fs from 'node:fs';
import * as path from 'node:path';
import * as runtime from '../runtime';
import { errorMessage } from '../errorMessage';
import { isElectronApp, startedViaCli, getUserDataPath } from './context';
import { writeConsole } from './consoleSink';

// Create logs directory in the same location as settings.
// Wrapped in try/catch so the Capacitor WebView (no fs) can load the
// logger module without crashing — file writes downstream silently
// no-op when logsDir is '' / fs is the bundler shim.
let logsDir = '';
try {
    logsDir = path.join(getUserDataPath(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
} catch (err) {
    // Browser / Capacitor context — fs is a require shim. Logger falls
    // back to console output only; in-app log streaming uses sendLogToGUI.
    writeConsole('debug', '[logger] fs not available; skipping file-based logging:', errorMessage(err));
    logsDir = '';
}

const getCurrentDate = () => {
    return new Date().toISOString().split('T')[0];
};

/**
 * @param date - YYYY-MM-DD
 */
const getLogFilePaths = (
    date: string = getCurrentDate(),
): { error: string; app: string; api: string; settings: string } => {
    return {
        error: path.join(logsDir, `errors-${date}.log`),
        app: path.join(logsDir, `app-${date}.log`),
        api: path.join(logsDir, `api-${date}.log`),
        settings: path.join(logsDir, `settings-${date}.log`),
    };
};

// Per-log-prefix retention rules: { days, maxMB }.
const LOG_RETENTION: Record<string, { days: number; maxMB: number }> = {
    errors: { days: 30, maxMB: 10 },
    app: { days: 7, maxMB: 50 },
    api: { days: 1, maxMB: 20 },
    settings: { days: 7, maxMB: 10 },
};

// Parse date from filename (e.g., "errors-2025-07-28.log" -> "2025-07-28")
const parseDateFromFilename = (filename: string): string | null => {
    const match = filename.match(/(errors|app|api|settings)-(\d{4}-\d{2}-\d{2})\.log$/);
    return match ? match[2] : null;
};

// Check if a date is older than specified days
const isDateOlderThan = (dateString: string, days: number): boolean => {
    const fileDate = new Date(dateString);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    return fileDate < cutoffDate;
};

const cleanupOldLogs = () => {
    // Browser / Capacitor context has no logsDir; nothing to clean up.
    if (!logsDir) return;
    try {
        // A non-empty logsDir means the module-load existsSync/mkdirSync on the
        // real fs succeeded, so fs is usable here; the directory may still have
        // been removed since.
        if (!fs.existsSync(logsDir)) {
            return;
        }

        const files = fs.readdirSync(logsDir);
        const now = new Date();

        files.forEach((file) => {
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            const fileSizeMB = stats.size / (1024 * 1024);

            let shouldDelete = false;
            let reason = '';

            const fileDate = parseDateFromFilename(file);

            if (fileDate) {
                const prefix = Object.keys(LOG_RETENTION).find((p) => file.startsWith(`${p}-`));
                if (prefix) {
                    const { days, maxMB } = LOG_RETENTION[prefix];
                    const tooOld = isDateOlderThan(fileDate, days);
                    shouldDelete = tooOld || fileSizeMB > maxMB;
                    reason = tooOld ? 'age' : 'size';
                }
            } else if (file.startsWith('api-debug-')) {
                const fileAge = now.getTime() - stats.mtime.getTime();
                shouldDelete = fileAge > 7 * 24 * 60 * 60 * 1000; // 7 days
                reason = 'age';
            }

            if (shouldDelete) {
                fs.unlinkSync(filePath);
                writeConsole('log', `Cleaned up old log file: ${file} (${reason}, ${fileSizeMB.toFixed(2)} MB)`);
            }
        });
    } catch (error) {
        // Silently ignore cleanup errors in test environments
        if (!runtime.isTest()) {
            writeConsole('error', 'Error during log cleanup:', error);
        }
    }
};

cleanupOldLogs();

// Set up periodic cleanup (every hour) only in actual application contexts
let cleanupInterval: ReturnType<typeof setInterval> | undefined;
if (isElectronApp || startedViaCli) {
    cleanupInterval = setInterval(cleanupOldLogs, 60 * 60 * 1000); // 1 hour
}

process.on('exit', () => {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
    }
});

const currentLogFiles = getLogFilePaths();

export { logsDir, currentLogFiles, cleanupOldLogs };
