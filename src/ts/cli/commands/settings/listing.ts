// List settings, global defaults and the schema from the CLI.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { getDefaultSettings } from '../../../settings';
import { formatSettingForLog } from './shared';

import type { SettingsSchemaEntry } from '../../../settings/schema';

// The listings print to the console only (never into the log files): they carry the account's
// settings. printLine redacts credential-looking lines on top of formatSettingForLog's masking.
export const listSettings = (challengeId: string | null = null) => {
    try {
        if (challengeId) {
            const schema = settings.SETTINGS_SCHEMA as Record<string, SettingsSchemaEntry>;
            const perChallengeKeys = Object.keys(schema)
                .filter((key) => schema[key].perChallenge)
                .sort();

            logger.printLine(`=== Settings for challenge ${challengeId} ===`);
            perChallengeKeys.forEach((key) => {
                const effective = settings.getEffectiveSetting(key, challengeId);
                const isOverride = settings.getChallengeOverride(key, challengeId) !== null;
                const status = isOverride ? 'Override ✏️' : 'Inherited ✅';
                logger.printLine(`${key}: ${formatSettingForLog(key, effective)}  [${status}]`);
            });
            logger.printLine(
                '💡 Only per-challenge-capable settings are shown. Use "list-settings" for all global settings.',
            );
            return;
        }

        const userSettings = settings.loadSettings();
        const defaultSettings = getDefaultSettings();

        logger.printLine('=== All Settings ===');

        const allKeys = new Set([...Object.keys(userSettings), ...Object.keys(defaultSettings)]);
        const sortedKeys = Array.from(allKeys).sort();

        sortedKeys.forEach((key) => {
            const currentValue = userSettings[key];
            const defaultValue = defaultSettings[key];
            const isModified = JSON.stringify(currentValue) !== JSON.stringify(defaultValue);

            logger.printLine(`${key}:`);
            logger.printLine(`  Current: ${formatSettingForLog(key, currentValue)}`);
            logger.printLine(`  Default: ${formatSettingForLog(key, defaultValue)}`);
            if (isModified) {
                logger.printLine('  Status:  Modified ✏️');
            } else {
                logger.printLine('  Status:  Default ✅');
            }
            logger.printLine('');
        });

        logger.printLine('💡 Use "help-settings" for detailed information about each setting');
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
        logger.withCategory('ui').info(`  Default: ${formatSettingForLog(key, config.default)}`);
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
    logger.printLine('Global Defaults for Schema Settings:');
    logger.printLine('===================================');
    Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
        const currentValue = stored[key] !== undefined ? stored[key] : config.default;
        logger.printLine(`${key}: ${formatSettingForLog(key, currentValue)}`);
    });
};
