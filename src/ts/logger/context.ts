import * as runtime from '../runtime';

// Whether this is a real Electron process (main or renderer). Decided by
// process.versions.electron via runtime, not process.type: the WebView
// bundles' process stub reports type 'browser' too.
const isElectronApp = runtime.isElectron();

// Runtime owns the single implementation of source-detection, app naming,
// and user-data resolution — logger re-exports isSourceCode/getAppName
// because settings.ts and tests consume them through this module.
const { isSourceCode, getAppName } = runtime;
const getUserDataPath = runtime.getAppUserDataPath;

// Check if we're in development mode (not mock)
const devMode = runtime.isDevelopment();

// Check if we're in CLI mode vs GUI mode
// CLI mode: running directly from cli.ts (through tsx, or as its .js bundle) or when
// electron main process handles CLI commands
// GUI mode: electron main process handling GUI IPC calls
const startedViaCli = Boolean(process.argv[1] && /cli\.[jt]s/.test(process.argv[1]));
const cliMode = !isElectronApp || startedViaCli;

// Context override for explicit context setting
let contextOverride: string | null = null;

/**
 * Set explicit context override (for IPC calls from GUI)
 */
const setContext = (context: string) => {
    contextOverride = context;
};

/**
 * Clear context override
 */
const clearContext = () => {
    contextOverride = null;
};

/**
 * Get context identifier (CLI/GUI)
 */
const getContext = (): string => {
    // Use explicit override if set
    if (contextOverride) {
        return contextOverride;
    }

    // Check if we're in a pure CLI environment (no Electron at all)
    if (!isElectronApp) {
        return 'CLI';
    }

    // If we're in Electron, check if we were started via CLI
    if (startedViaCli) {
        return 'CLI';
    }

    // Default for Electron main process is GUI
    return 'GUI';
};

export {
    isElectronApp,
    isSourceCode,
    getAppName,
    getUserDataPath,
    devMode,
    startedViaCli,
    cliMode,
    getContext,
    setContext,
    clearContext,
};
