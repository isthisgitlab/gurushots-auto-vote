/**
 * Settings-file watcher for the Electron main process. Watches the
 * directory of the config.json the facade owns, for that file's name (the
 * file is replaced by a rename on every save, which ends a watch on the file
 * itself), and, on change, logs the diff and broadcasts a `settings-changed`
 * event to every renderer window (so React hooks can refetch without a
 * reload — catches CLI-originated changes). No window is ever reloaded: each
 * renderer follows a setting live, and a reload would end the auto-vote
 * cadence chain the main renderer owns.
 *
 * Separate from index/windows.ts's createMainWindow — window creation has
 * nothing to do with file watching. The caller owns the returned fs.FSWatcher's
 * lifecycle (index/windows.ts closes it when the main window closes).
 */

import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import { basename, dirname } from 'node:path';
import * as settings from '../settings';
import * as logger from '../logger';
import { SENSITIVE_KEY_RE, REDACTED } from '../logger/sanitize';
import { PRIVATE_SETTING_KEYS, maskSettingValue } from '../format/settingsLogMask';

import type { ConfigV2 } from '../types/config';
import { errorMessage } from '../errorMessage';
import { toRendererSettings } from '../ipc/rendererSettings';
type SettingChange = { key: string; oldValue: string; newValue: string };

// Debounce timeout shared across successive watchSettingsFile calls (the
// main window can be torn down and re-created on logout/login): a new
// watcher's first change event clears a still-pending handler scheduled by
// the previous watcher.
let settingsDebounceTimeout: NodeJS.Timeout | null = null;

// Function to safely stringify values for comparison and logging
const stringify = (value: unknown) => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

// A change anywhere under `auth`, under a credential key (token, ...), anywhere in apiHeaders, or in a setting that
// names the account (lastUsername, chosenPhotosMemberId) is logged masked on both sides: the
// log line's own redaction only scrubs the first value after `key:`, which would leave the
// new credential in clear.
const isSensitivePath = (path: string) =>
    path
        .split('.')
        .some(
            (segment) =>
                segment === 'auth' ||
                segment === 'apiHeaders' ||
                PRIVATE_SETTING_KEYS.has(segment) ||
                SENSITIVE_KEY_RE.test(segment),
        );

// A value as the log shows it. A whole object that appeared or vanished is stringified in
// full, so it is masked key by key; a chosenPhotos list, at any depth, shows as a count.
const describeValue = (path: string, value: unknown): string => {
    const lastSegment = path.slice(path.lastIndexOf('.') + 1);
    return stringify(maskSettingValue({ [lastSegment]: value })[lastSegment]);
};

const describeChange = (path: string, oldValue: unknown, newValue: unknown): SettingChange =>
    isSensitivePath(path)
        ? { key: path, oldValue: REDACTED, newValue: REDACTED }
        : { key: path, oldValue: describeValue(path, oldValue), newValue: describeValue(path, newValue) };

/**
 * Compare two settings objects and return array of changes
 * @param oldSettings - Previous settings object
 * @param newSettings - New settings object
 * @returns Array of change objects with key, oldValue, newValue
 */
function compareSettings(oldSettings: unknown, newSettings: unknown): SettingChange[] {
    const changes: SettingChange[] = [];

    // Recursive function to compare nested objects
    const compareRecursive = (oldObj: unknown, newObj: unknown, path: string = '') => {
        // Handle null/undefined cases
        if (oldObj === null || oldObj === undefined || newObj === null || newObj === undefined) {
            if (oldObj !== newObj) {
                changes.push(describeChange(path, oldObj, newObj));
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
                const oldValue = (oldObj as Record<string, unknown>)[key];
                const newValue = (newObj as Record<string, unknown>)[key];

                compareRecursive(oldValue, newValue, newPath);
            }
        } else {
            // For primitive values or arrays, do direct comparison
            if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) {
                changes.push(describeChange(path, oldObj, newObj));
            }
        }
    };

    // Start recursive comparison
    compareRecursive(oldSettings, newSettings);

    return changes;
}

/**
 * Watch the settings file for changes and broadcast them with debouncing.
 * The facade owns the path — never re-derive it here.
 *
 * The main window receives an in-app save twice: once from the IPC broadcast
 * (immediate) and once from this watcher 500 ms later. That is harmless (a
 * broadcast only triggers an idempotent refetch), and this watcher is the only
 * path for CLI and hand edits, so it must not be "deduplicated" away.
 *
 * @param deps - `onSettingsChanged` is an OPTIONAL side-channel fired with a
 *   freshly loaded snapshot on every successful load of the debounced handler,
 *   so main-process state that must track a setting (e.g. the auto-vote
 *   power-save blocker in windows/backgroundActivity.ts) can follow a change
 *   the renderer made without inventing a second IPC channel. Exceptions it
 *   throws are swallowed: an observer must never stop the watcher from
 *   broadcasting.
 *
 *   NOTE for implementers: the debounce handle is module-level and is NOT
 *   cleared by the returned watcher's `close()`, so a callback armed before a
 *   window teardown still fires afterwards. The broadcast path below skips
 *   destroyed windows; an observer must make the equivalent liveness check
 *   itself (see index.ts) rather than assume a window still exists.
 * @returns the watcher (caller owns closing it), or
 *   null when no settings file exists yet.
 */
function watchSettingsFile({
    onSettingsChanged = null,
}: {
    onSettingsChanged?: ((settings: ConfigV2) => void) | null;
}): fs.FSWatcher | null {
    const settingsPath = settings.getSettingsPath();
    let previousSettings: ConfigV2 | null = null;

    if (!fs.existsSync(settingsPath)) {
        return null;
    }

    // Store initial settings state
    try {
        previousSettings = settings.loadSettings();
    } catch (error) {
        logger.withCategory('settings').error('Failed to load initial settings for comparison:', errorMessage(error));
    }

    // Hand the observer a snapshot the caller already loaded. Never throws: a
    // buggy observer must not cost the renderers their broadcast.
    const notifyObserver = (snapshot: ConfigV2) => {
        if (!onSettingsChanged) return;
        try {
            onSettingsChanged(snapshot);
        } catch (error) {
            logger.withCategory('settings').warning(`Settings observer failed: ${errorMessage(error) || error}`);
        }
    };

    const settingsFileName = basename(settingsPath);
    // A replaced file reports as a rename of its name, a rewritten one as a change; the other files of the directory
    // (the temp file of a save in progress, the other stores) are not the settings. A platform that does not name
    // the file might mean it.
    return fs.watch(dirname(settingsPath), (_eventType, fileName) => {
        if (fileName === null || fileName === settingsFileName) {
            // Clear existing timeout to debounce rapid file changes
            if (settingsDebounceTimeout) {
                clearTimeout(settingsDebounceTimeout);
            }

            // Handle the change after a short delay to coalesce rapid writes
            settingsDebounceTimeout = setTimeout(() => {
                // Load new settings and compare with previous
                let newSettings: ConfigV2;
                try {
                    newSettings = settings.loadSettings();
                } catch (error) {
                    // Nothing is sent and the observer is not called; the old baseline stays,
                    // so the next good load still diffs against it.
                    logger
                        .withCategory('settings')
                        .error('Failed to load new settings for comparison:', errorMessage(error));
                    return;
                }

                let hasChanges = false;
                if (previousSettings) {
                    const changes = compareSettings(previousSettings, newSettings);
                    if (changes.length > 0) {
                        hasChanges = true;
                        logger.withCategory('settings').info('🔄 Settings changed:');
                        changes.forEach((change) => {
                            logger
                                .withCategory('settings')
                                .info(`  • ${change.key}: ${change.oldValue} → ${change.newValue}`);
                        });
                    } else {
                        logger
                            .withCategory('settings')
                            .info('🔄 Settings file changed (no property differences detected)');
                    }
                } else {
                    // No baseline to diff against: the snapshot is adopted below and broadcast once.
                    // No value is logged, as there is no diff to mask.
                    logger.withCategory('settings').info('🔄 Settings file changed (no earlier snapshot to compare)');
                    hasChanges = true;
                }

                // Update previous settings for next comparison
                previousSettings = newSettings;

                // Fire the observer on every successful load (even when nothing
                // differed — a snapshot is a snapshot).
                notifyObserver(newSettings);

                if (hasChanges) {
                    // Notify every renderer window (the main one included) so React
                    // hooks can refetch without a reload (catches CLI-originated changes).
                    const rendererSettings = toRendererSettings(newSettings);
                    BrowserWindow.getAllWindows().forEach((win) => {
                        if (!win.isDestroyed()) {
                            win.webContents.send('settings-changed', rendererSettings);
                        }
                    });
                }
            }, 500); // 500ms debounce
        }
    });
}

export { watchSettingsFile };
