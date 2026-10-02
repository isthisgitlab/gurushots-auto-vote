// List settings, global defaults and the schema from the CLI.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { getDefaultSettings } from '../../../settings';
import { formatSettingForLog } from './shared';

import type { SettingsSchemaEntry } from '../../../settings/schema';

export const listSettings = (challengeId: string | null = null) => {
    try {
        if (challengeId) {
            const schema = settings.SETTINGS_SCHEMA as Record<string, SettingsSchemaEntry>;
            const perChallengeKeys = Object.keys(schema)
                .filter((key) => schema[key].perChallenge)
                .sort();

            logger.withCategory('settings').info(`=== Settings for challenge ${challengeId} ===`);
            perChallengeKeys.forEach((key) => {
                const effective = settings.getEffectiveSetting(key, challengeId);
                const isOverride = settings.getChallengeOverride(key, challengeId) !== null;
                const status = isOverride ? 'Override ✏️' : 'Inherited ✅';
                logger.withCategory('settings').info(`${key}: ${formatSettingForLog(key, effective)}  [${status}]`);
            });
            logger
                .withCategory('ui')
                .info('💡 Only per-challenge-capable settings are shown. Use "list-settings" for all global settings.');
            return;
        }

        const userSettings = settings.loadSettings();
        const defaultSettings = getDefaultSettings();

        logger.withCategory('settings').info('=== All Settings ===');

        const allKeys = new Set([...Object.keys(userSettings), ...Object.keys(defaultSettings)]);
        const sortedKeys = Array.from(allKeys).sort();

        sortedKeys.forEach((key) => {
            const currentValue = userSettings[key];
            const defaultValue = defaultSettings[key];
            const isModified = JSON.stringify(currentValue) !== JSON.stringify(defaultValue);

            logger.withCategory('settings').info(`${key}:`);
            logger.withCategory('settings').info(`  Current: ${formatSettingForLog(key, currentValue)}`);
            logger.withCategory('settings').info(`  Default: ${formatSettingForLog(key, defaultValue)}`);
            if (isModified) {
                logger.withCategory('settings').info('  Status:  Modified ✏️');
            } else {
                logger.withCategory('settings').info('  Status:  Default ✅');
            }
            logger.withCategory('settings').info('');
        });

        logger.withCategory('ui').info('💡 Use "help-settings" for detailed information about each setting');
    } catch (error) {
        logger.withCategory('settings').error('Error listing settings', error);
    }
};

/**
 * Print the full settings schema (type, default, per-challenge flag, label,
 * description per key). Shared by `pnpm settings:schema` and available to
 * the main CLI.
 */
export const dumpSchema = () => {
    logger.withCategory('ui').info('Settings Schema:');
    logger.withCategory('ui').info('================');
    Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
        logger.withCategory('ui').info(`\n${key}:`);
        logger.withCategory('ui').info(`  Type: ${config.type}`);
        logger.withCategory('ui').info(`  Default: ${JSON.stringify(config.default)}`);
        logger.withCategory('ui').info(`  Per-Challenge: ${config.perChallenge ? 'Yes' : 'No'}`);
        if (config.label) logger.withCategory('ui').info(`  Label: ${config.label}`);
        if (config.description) logger.withCategory('ui').info(`  Description: ${config.description}`);
    });
};

/**
 * Print the effective global default for every schema key (stored override
 * or schema default). Shared by `pnpm settings:global-defaults`.
 */
export const listGlobalDefaults = () => {
    const stored = settings.loadSettings().challengeSettings?.globalDefaults || {};
    logger.withCategory('ui').info('Global Defaults for Schema Settings:');
    logger.withCategory('ui').info('===================================');
    Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
        const currentValue = stored[key] !== undefined ? stored[key] : config.default;
        logger.withCategory('ui').info(`${key}: ${JSON.stringify(currentValue)}`);
    });
};
