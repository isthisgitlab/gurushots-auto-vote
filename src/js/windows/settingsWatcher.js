/**
 * Settings-file watcher for the Electron main process. Watches the
 * settings.json the facade owns and, on change, either reloads the main
 * window (reload-required keys), broadcasts a `settings-changed` event to
 * all renderer windows (so React hooks can refetch without a full reload —
 * catches CLI-originated changes), or just logs the diff.
 *
 * Extracted from index.js's createMainWindow — window creation has nothing
 * to do with file watching. The caller owns the returned fs.FSWatcher's
 * lifecycle (index.js closes it when the main window closes).
 */

const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const settings = require('../settings');
const logger = require('../logger');

// Debounce timeout shared across successive watchSettingsFile calls (the
// main window can be torn down and re-created on logout/login): a new
// watcher's first change event clears a still-pending reload scheduled by
// the previous watcher, exactly as the old index.js module-level variable did.
let settingsReloadTimeout = null;

/**
 * Compare two settings objects and return array of changes
 * @param {Object} oldSettings - Previous settings object
 * @param {Object} newSettings - New settings object
 * @returns {Array} Array of change objects with key, oldValue, newValue
 */
function compareSettings(oldSettings, newSettings) {
    const changes = [];

    // Function to safely stringify values for comparison and logging
    const stringify = (value) => {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    };

    // Recursive function to compare nested objects
    const compareRecursive = (oldObj, newObj, path = '') => {
        // Handle null/undefined cases
        if (oldObj === null || oldObj === undefined || newObj === null || newObj === undefined) {
            if (oldObj !== newObj) {
                changes.push({
                    key: path,
                    oldValue: stringify(oldObj),
                    newValue: stringify(newObj),
                });
            }
            return;
        }

        // If both are objects, recurse into them
        if (
            typeof oldObj === 'object' &&
            typeof newObj === 'object' &&
            !Array.isArray(oldObj) &&
            !Array.isArray(newObj)
        ) {
            const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

            for (const key of allKeys) {
                const newPath = path ? `${path}.${key}` : key;
                const oldValue = oldObj[key];
                const newValue = newObj[key];

                compareRecursive(oldValue, newValue, newPath);
            }
        } else {
            // For primitive values or arrays, do direct comparison
            if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) {
                changes.push({
                    key: path,
                    oldValue: stringify(oldObj),
                    newValue: stringify(newObj),
                });
            }
        }
    };

    // Start recursive comparison
    compareRecursive(oldSettings, newSettings);

    return changes;
}

/**
 * Watch the settings file for changes and auto-reload with debouncing.
 * The facade owns the path — never re-derive it here.
 *
 * @param {{
 *   getMainWindow: () => (import('electron').BrowserWindow|null),
 *   getMainWindowCreatedTime: () => (number|null),
 *   onSettingsChanged?: ((settings: Object) => void)|null,
 * }} deps - accessors for the window state index.js still owns; read at
 *   event time so the watcher always sees the current window/creation time.
 *   `onSettingsChanged` is an OPTIONAL side-channel fired with every freshly
 *   loaded snapshot (before the reload/broadcast branch), so main-process
 *   state that must track a setting — e.g. the auto-vote power-save blocker in
 *   windows/backgroundActivity.js — can follow a change the renderer made
 *   without inventing a second IPC channel for it. Exceptions it throws are
 *   swallowed: an observer must never stop the watcher from reloading or
 *   broadcasting.
 * @returns {fs.FSWatcher|null} the watcher (caller owns closing it), or
 *   null when no settings file exists yet.
 */
function watchSettingsFile({ getMainWindow, getMainWindowCreatedTime, onSettingsChanged = null }) {
    const settingsPath = settings.getSettingsPath();
    let previousSettings = null;

    if (!fs.existsSync(settingsPath)) {
        return null;
    }

    // Store initial settings state
    try {
        previousSettings = settings.loadSettings();
    } catch (error) {
        logger.withCategory('settings').error('Failed to load initial settings for comparison:', error.message);
    }

    return fs.watch(settingsPath, (eventType) => {
        if (eventType === 'change') {
            // Clear existing timeout to debounce rapid file changes
            if (settingsReloadTimeout) {
                clearTimeout(settingsReloadTimeout);
            }

            // Reload after a short delay to avoid rapid reloads
            settingsReloadTimeout = setTimeout(() => {
                // Prevent reload if main window was just created (during login)
                const timeSinceCreation = Date.now() - getMainWindowCreatedTime();
                if (timeSinceCreation < 2000) {
                    // 2 second window
                    logger
                        .withCategory('settings')
                        .info('🔄 Settings file changed, but skipping reload (window recently created)');
                    return;
                }

                // Load new settings and compare with previous
                let newSettings;
                let shouldReload = false;
                let hasChanges = false;
                try {
                    newSettings = settings.loadSettings();

                    if (previousSettings) {
                        const changes = compareSettings(previousSettings, newSettings);
                        if (changes.length > 0) {
                            hasChanges = true;
                            // Check if any of the changed settings require reload
                            const reloadRequiredChanges = changes.filter((change) => {
                                const settingKey = change.key.split('.')[0]; // Get main setting key
                                return settings.isReloadRequired(settingKey);
                            });

                            if (reloadRequiredChanges.length > 0) {
                                logger
                                    .withCategory('settings')
                                    .info('🔄 Reload-required settings changed, reloading main window...');
                                reloadRequiredChanges.forEach((change) => {
                                    logger
                                        .withCategory('settings')
                                        .info(
                                            `  • ${change.key}: ${change.oldValue} → ${change.newValue} (reload required)`,
                                        );
                                });
                                shouldReload = true;
                            } else {
                                logger.withCategory('settings').info('🔄 Settings changed (no reload required):');
                                changes.forEach((change) => {
                                    logger
                                        .withCategory('settings')
                                        .info(`  • ${change.key}: ${change.oldValue} → ${change.newValue}`);
                                });
                            }
                        } else {
                            logger
                                .withCategory('settings')
                                .info('🔄 Settings file changed (no property differences detected)');
                        }
                    } else {
                        logger.withCategory('settings').info('🔄 Settings file changed, reloading main window...');
                        shouldReload = true;
                    }

                    // Update previous settings for next comparison
                    previousSettings = newSettings;
                } catch (error) {
                    logger.withCategory('settings').error('Failed to load new settings for comparison:', error.message);
                    logger.withCategory('settings').info('🔄 Settings file changed, reloading main window...');
                    shouldReload = true;
                }

                // Fire the observer on every successful load, whichever branch
                // runs below (and even when nothing differed — a snapshot is a
                // snapshot). Guarded so a buggy observer cannot cost the
                // window its reload.
                if (onSettingsChanged && newSettings) {
                    try {
                        onSettingsChanged(newSettings);
                    } catch (error) {
                        logger.withCategory('settings').warning(`Settings observer failed: ${error?.message || error}`);
                    }
                }

                const mainWindow = getMainWindow();
                if (shouldReload && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.reload();
                } else if (hasChanges && newSettings) {
                    // Notify all renderer windows so React hooks can refetch
                    // without a full reload. Catches CLI-originated changes.
                    BrowserWindow.getAllWindows().forEach((win) => {
                        if (!win.isDestroyed()) {
                            win.webContents.send('settings-changed', newSettings);
                        }
                    });
                }
            }, 500); // 500ms debounce
        }
    });
}

module.exports = { watchSettingsFile };
