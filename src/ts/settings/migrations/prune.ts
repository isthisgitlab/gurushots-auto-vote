import * as logger from '../../logger';
import { SETTINGS_SCHEMA } from '../schema';

import type { AppSettings, ChallengeValues } from '../../types/settings';

/**
 * Delete globalDefaults keys the schema no longer defines. Returns true on change.
 */
const _pruneGlobalDefaultKeys = (globalDefaults: ChallengeValues, validSchemaKeys: string[]): boolean => {
    const invalidGlobalKeys = Object.keys(globalDefaults).filter((key) => !validSchemaKeys.includes(key));
    if (invalidGlobalKeys.length === 0) return false;
    logger.withCategory('settings').debug(`Removing invalid global default keys: ${invalidGlobalKeys.join(', ')}`);
    invalidGlobalKeys.forEach((key) => {
        delete globalDefaults[key];
    });
    return true;
};

// Delete per-challenge override keys the schema no longer defines, then any
// container left empty. Returns true on change.
const _prunePerChallengeKeys = (perChallenge: Record<string, ChallengeValues>, validSchemaKeys: string[]): boolean => {
    let hasChanges = false;
    for (const challengeId of Object.keys(perChallenge)) {
        const challengeOverrides = perChallenge[challengeId];
        const invalidKeys = Object.keys(challengeOverrides).filter((key) => !validSchemaKeys.includes(key));

        if (invalidKeys.length > 0) {
            logger
                .withCategory('settings')
                .debug(`Removing invalid override keys for challenge ${challengeId}:`, invalidKeys);
            invalidKeys.forEach((key) => {
                delete challengeOverrides[key];
            });
            hasChanges = true;
        }

        if (Object.keys(challengeOverrides).length === 0) {
            delete perChallenge[challengeId];
            hasChanges = true;
        }
    }
    return hasChanges;
};

/**
 * Delete the top-level boostConfig key and every globalDefaults / perChallenge
 * key the schema does not define. Mutates `settings` in place; returns true
 * when anything was removed.
 */
export const pruneObsoleteSettings = (settings: AppSettings): boolean => {
    let hasChanges = false;

    if (settings.boostConfig) {
        logger.withCategory('settings').debug('Removing legacy boostConfig', null);
        delete settings.boostConfig;
        hasChanges = true;
    }

    const { globalDefaults, perChallenge } = settings.challengeSettings;
    const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
    hasChanges = _pruneGlobalDefaultKeys(globalDefaults, validSchemaKeys) || hasChanges;
    hasChanges = _prunePerChallengeKeys(perChallenge, validSchemaKeys) || hasChanges;

    return hasChanges;
};
