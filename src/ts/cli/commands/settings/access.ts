// Get and set setting values from the CLI (global, per-challenge, global defaults).

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { parseSettingValue } from '../../parseValue';
import { formatSettingForLog, logUnknownSchemaKey, requirePerChallenge, schemaEntry } from './shared';

import type { SettingsSchemaEntry } from '../../../settings/schema';
import type { SchemaByKey } from './shared';

export const getSetting = (key: string, challengeId: string | null = null) => {
    try {
        if (challengeId) {
            if (!requirePerChallenge(key)) return;
            const effective = settings.getEffectiveSetting(key, challengeId);
            const isOverride = settings.getChallengeOverride(key, challengeId) !== null;
            const status = isOverride ? 'override' : 'inherited from global default';
            logger
                .withCategory('settings')
                .info(`${key} [challenge ${challengeId}]: ${formatSettingForLog(key, effective)} (${status})`);
            return true;
        }
        const value = settings.getSetting(key);
        if (value === undefined) {
            logger.withCategory('settings').error(`Setting '${key}' not found`);
            return false;
        }
        logger.withCategory('settings').info(`${key}: ${formatSettingForLog(key, value)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error getting setting '${key}'`, error);
        return false;
    }
};

/**
 * @param value - the raw argv token
 */
export const setSetting = (key: string, value: string, challengeId: string | null = null): boolean => {
    try {
        const parsedValue = parseSettingValue(value);
        if (challengeId) {
            if (!requirePerChallenge(key)) return false;
            if (settings.setChallengeOverride(key, challengeId, parsedValue)) {
                logger
                    .withCategory('settings')
                    .success(`Set ${key} = ${formatSettingForLog(key, parsedValue)} for challenge ${challengeId}`);
                return true;
            }
            logger
                .withCategory('settings')
                .error(`Failed to set ${key} for challenge ${challengeId} — validation failed`);
            return false;
        }
        // A schema key with no --challenge would otherwise be written as an unvalidated
        // top-level key that nothing ever reads — reporting success and changing nothing.
        // Setting the global default is what the user meant; say so rather than doing it
        // silently, so a script author can see the redirect in the output.
        const entry = schemaEntry(key);
        if (entry) {
            // Worded for both kinds of schema key: most support per-challenge overrides, but
            // a few (lastMinuteCheckFrequency) are global-only, and pointing those at
            // --challenge would just hit requirePerChallenge's rejection.
            logger.withCategory('settings').info(`'${key}' is a voting setting — applying it as the global default`);
            if (entry.perChallenge) {
                logger
                    .withCategory('settings')
                    .info(`Use --challenge <id> to override it for a single challenge instead`);
            }
            return setGlobalDefault(key, value);
        }

        if (!settings.setSetting(key, parsedValue)) {
            logger.withCategory('settings').error(`Failed to save setting '${key}' - validation failed`);
            return false;
        }
        logger.withCategory('settings').success(`Set ${key} = ${formatSettingForLog(key, parsedValue)}`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error(`Error setting '${key}'`, error);
        return false;
    }
};

/**
 * @param value - the raw argv token
 */
export const setGlobalDefault = (key: string, value: string): boolean => {
    try {
        const parsedValue = parseSettingValue(value);

        const schema = settings.SETTINGS_SCHEMA as SchemaByKey;
        if (!schema[key]) {
            logUnknownSchemaKey(key);
            return false;
        }

        const success = settings.setGlobalDefault(key, parsedValue);
        if (success) {
            const actualValue = settings.getGlobalDefault(key);
            logger.withCategory('settings').success(`Set global default ${key} = ${JSON.stringify(actualValue)}`);
            return true;
        }
        logger.withCategory('settings').error(`Failed to set global default '${key}' - validation failed`);
        logger
            .withCategory('settings')
            .error(`Value ${formatSettingForLog(key, parsedValue)} is invalid for this setting`);

        const config = schema[key] as SettingsSchemaEntry;
        logger
            .withCategory('settings')
            .info(`Setting info: ${config.type} type, default: ${JSON.stringify(config.default)}`);
        return false;
    } catch (error) {
        logger.withCategory('settings').error(`Error setting global default '${key}'`, error);
        return false;
    }
};
