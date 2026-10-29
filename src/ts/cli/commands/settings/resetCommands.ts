// Reset settings, global defaults, all settings and window positions from the CLI.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { getDefaultSettings } from '../../../settings';
import { formatSettingForLog, logUnknownSchemaKey, requirePerChallenge, schemaEntry } from './shared';

export const resetSetting = (key: string, challengeId: string | null = null) => {
    try {
        if (challengeId) {
            if (!requirePerChallenge(key)) return false;
            if (!settings.removeChallengeOverride(key, challengeId)) {
                logger
                    .withCategory('settings')
                    .error(
                        `Could not reset ${key} for challenge ${challengeId}; its remaining settings would conflict`,
                    );
                return false;
            }
            logger
                .withCategory('settings')
                .success(`Reset ${key} for challenge ${challengeId} (now inherits its profile/global baseline)`);
            return true;
        }
        const defaultSettings = getDefaultSettings().app;
        const defaultValue = defaultSettings[key];

        if (defaultValue === undefined) {
            // Not an app key: a schema key resets its global default, the same
            // path `reset-global-default` takes. Anything else stays unknown.
            if (schemaEntry(key)) return resetGlobalDefault(key);
            logger.withCategory('settings').error(`Setting '${key}' not found in defaults`);
            return false;
        }

        if (!settings.setSetting(key, defaultValue)) {
            logger.withCategory('settings').error(`Could not reset ${key} to its default`);
            return false;
        }
        logger.withCategory('settings').success(`Reset ${key} to default: ${formatSettingForLog(key, defaultValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting setting '${key}'`, error);
        return false;
    }
};

export const resetGlobalDefault = (key: string) => {
    try {
        const entry = schemaEntry(key);
        if (!entry) {
            logUnknownSchemaKey(key);
            return false;
        }
        if (!settings.resetGlobalDefault(key)) {
            logger.withCategory('settings').error(`Failed to reset global default '${key}'`);
            return false;
        }
        const defaultValue = entry.default;
        logger
            .withCategory('settings')
            .success(`Reset global default ${key} to: ${formatSettingForLog(key, defaultValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting global default '${key}'`, error);
        return false;
    }
};

/**
 * Reset every schema setting's global default. Without --yes it lists the ones
 * that differ from their shipped value (current → default) and changes
 * nothing; --yes resets them all. Returns false on a failed reset.
 */
export const resetAllGlobalDefaults = (yes: boolean) => {
    try {
        if (!yes) {
            const modified = Object.entries(settings.SETTINGS_SCHEMA).filter(([key]) =>
                settings.isGlobalDefaultModified(key),
            );
            if (modified.length === 0) {
                logger
                    .withCategory('settings')
                    .info('No global default differs from its shipped value. Nothing to reset.');
                return true;
            }
            for (const [key, entry] of modified) {
                logger.printLine(
                    `${key}: ${formatSettingForLog(key, settings.getGlobalDefault(key))} → ${formatSettingForLog(key, entry.default)}`,
                );
            }
            logger
                .withCategory('settings')
                .info(
                    `Nothing reset yet. To reset these ${modified.length} global default(s), re-run: reset-all-global-defaults --yes`,
                );
            return true;
        }
        if (!settings.resetAllGlobalDefaults()) {
            logger.withCategory('settings').error('Failed to reset all global defaults');
            return false;
        }
        logger.withCategory('settings').success('All global defaults reset to their shipped values');
        return true;
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all global defaults', error);
        return false;
    }
};

export const resetAllSettings = () => {
    try {
        // Delegate to the facade so the CLI matches the GUI/IPC path and the
        // documented contract: it preserves token, mock flag, and apiHeaders.
        // (Re-implementing the loop here would wipe the auth token, because
        // getDefaultSettings() includes token:'' / mock / apiHeaders.)
        if (settings.resetAllSettings()) {
            logger
                .withCategory('settings')
                .success('All settings reset to defaults (token, mock flag, and API headers preserved)');
            logger.withCategory('ui').info('💡 Run "list-settings" to see all current values');
            return true;
        }
        logger.withCategory('settings').error('Failed to reset all settings');
        return false;
    } catch (error) {
        logger.withCategory('settings').error('Error resetting all settings', error);
        return false;
    }
};

export const resetWindows = () => {
    try {
        const userSettings = settings.loadSettings();
        const defaultSettings = settings.getDefaultSettings();
        userSettings.app.windowBounds = defaultSettings.app.windowBounds;
        settings.saveSettings(userSettings);
        logger.withCategory('settings').success('Window positions reset to default');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting window positions', error);
    }
};
