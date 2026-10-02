import type { BrowserWindow } from 'electron';
import type { AutoUpdater } from '../services/AutoUpdater';
import type { FSWatcher } from 'node:fs';

/**
 * The main process's mutable window and updater state, shared by the
 * window, startup and IPC modules. Windows are held so they are not garbage
 * collected; each field is nulled by its own window's 'closed' event.
 */
const appState: {
    loginWindow: BrowserWindow | null;
    mainWindow: BrowserWindow | null;
    // Created per main window by watchSettingsFile; the debounce timeout lives in windows/settingsWatcher.ts
    settingsWatcher: FSWatcher | null;
    autoUpdater: AutoUpdater | null;
    // Main window creation time, to prevent reload during login
    mainWindowCreatedTime: number | null;
} = {
    loginWindow: null,
    mainWindow: null,
    settingsWatcher: null,
    autoUpdater: null,
    mainWindowCreatedTime: null,
};

export { appState };
