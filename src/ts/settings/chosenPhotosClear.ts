/**
 * Remove every saved Chosen Photos list, wherever one lives: the global default,
 * per-challenge overrides, title rules (inline), profiles and scenario phases.
 *
 * Photo ids belong to one account, so this is what a user runs after switching
 * accounts (the other account's lists are ignored until then, and a list saved
 * under the new account would make them apply to it too). Only the lists go:
 * Submit Only Chosen Photos is a preference, not account data, and with no list
 * it already behaves as off.
 */

import * as logger from '../logger';
import { isPlainObject } from '../plainObject';
import { loadSettings, saveSettings } from './persistence';
import { ruleHasBehaviour } from './scenarios';

const LIST_KEY = 'chosenPhotos';

/**
 * Delete the list from one values map (a defaults, override, profile, rule or
 * phase-settings object). Returns 1 when it held photos, else 0 — an explicit
 * empty list is removed too but is not a list worth counting.
 */
const dropList = (values: unknown): number => {
    if (!isPlainObject(values) || !Object.prototype.hasOwnProperty.call(values, LIST_KEY)) return 0;
    const held = Array.isArray(values[LIST_KEY]) && values[LIST_KEY].length > 0;
    delete values[LIST_KEY];
    return held ? 1 : 0;
};

const sum = (counts: number[]): number => counts.reduce((total, count) => total + count, 0);

/**
 * Remove every chosen-photos list and forget which account saved them.
 *
 * @returns how many non-empty lists were removed, or null when the settings
 *   could not be saved
 */
const clearChosenPhotos = (): number | null => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings;
    let removed = dropList(challengeSettings.globalDefaults);

    for (const [challengeId, values] of Object.entries(challengeSettings.perChallenge)) {
        removed += dropList(values);
        // An override map that held nothing else has nothing left to say.
        if (isPlainObject(values) && Object.keys(values).length === 0)
            delete challengeSettings.perChallenge[challengeId];
    }
    removed += sum(Object.values(challengeSettings.profiles ?? {}).map(dropList));
    // A rule whose only content was the list has no reason to stay.
    challengeSettings.titleRules = challengeSettings.titleRules.filter((rule) => {
        const held = isPlainObject(rule) && Object.prototype.hasOwnProperty.call(rule, LIST_KEY);
        removed += dropList(rule);
        return !held || ruleHasBehaviour(rule);
    });
    for (const scenario of Object.values(challengeSettings.scenarios ?? {})) {
        const phases = isPlainObject(scenario) ? scenario.phases : null;
        if (isPlainObject(phases))
            removed += sum(
                Object.values(phases).map((phase) => dropList(isPlainObject(phase) ? phase.settings : null)),
            );
    }
    settings.chosenPhotosMemberId = '';
    // Announced to every open editor through the settings-changed broadcast (see the schema entry).
    settings.chosenPhotosClearedAt = new Date().toISOString();

    if (!saveSettings(settings)) return null;
    logger
        .withCategory('settings')
        .info(`Removed ${removed} chosen-photo list(s) from settings, rules, profiles and scenarios`, null);
    return removed;
};

export { clearChosenPhotos };
