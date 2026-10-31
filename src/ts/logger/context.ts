import * as runtime from '../runtime';
import { platform } from '../platform/port';
import { getAppName } from '../platform/appIdentity';

// The app identity and the user-data resolution are the platform's — logger
// re-exports isSourceCode/getAppName because settings.ts and tests consume
// them through this module.
const isSourceCode = () => platform().paths.isSourceCode();
const getUserDataPath = () => platform().paths.userData();

// Check if we're in development mode (not mock)
const devMode = runtime.isDevelopment();

// Check if we're in CLI mode vs GUI mode
// CLI mode: running directly from cli.ts (through tsx, or as its .js bundle) or when
// electron main process handles CLI commands
// GUI mode: electron main process handling GUI IPC calls
const startedViaCli = Boolean(process.argv[1] && /cli\.[jt]s/.test(process.argv[1]));
// The default rule is the platform's; the entry points install it before any
// core module (this module) loads.
const cliMode = platform().capabilities.logContext() === 'CLI';

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
    // Use explicit override if set, else the platform's default rule.
    return contextOverride ?? platform().capabilities.logContext();
};

export {
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
