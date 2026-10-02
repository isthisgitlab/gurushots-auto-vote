// Reset settings, global defaults, all settings and window positions from the CLI.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { getDefaultSettings } from '../../../settings';
import { logUnknownSchemaKey, requirePerChallenge, schemaEntry } from './shared';

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
        const defaultSettings = getDefaultSettings();
        const defaultValue = defaultSettings[key];

        if (defaultValue === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found in defaults`);
            return false;
        }

        settings.setSetting(key, defaultValue);
        logger.withCategory('settings').success(`Reset ${key} to default: ${JSON.stringify(defaultValue)}`);
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
        logger.withCategory('settings').success(`Reset global default ${key} to: ${JSON.stringify(defaultValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error resetting global default '${key}'`, error);
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
        userSettings.windowBounds = defaultSettings.windowBounds;
        settings.saveSettings(userSettings);
        logger.withCategory('settings').success('Window positions reset to default');
    } catch (error) {
        logger.withCategory('settings').error('Error resetting window positions', error);
    }
};
