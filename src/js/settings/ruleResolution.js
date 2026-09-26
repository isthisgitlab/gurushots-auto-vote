/**
 * Read-side resolution of challenge rules against a loaded settings object:
 * which rules match a challenge, the one profile they apply, the sparse value
 * map they contribute, per-challenge profile suppression, and whether a rule's
 * profile composes with the stored manual overrides. Pure over its `settings`
 * argument — no persistence.
 */

import { matchingRules } from './challengeRules';
import { challengeTargetForId } from './challengeFacts';
import { globalChallengeValues, challengeValueSetIsValid } from './defaults';
import {
    RESERVED_PROFILE_NAMES,
    normalizeProfileName,
    readProfilesMap,
    findProfileKey,
    sanitizeProfileValues,
} from './profileStore';
import { sanitizeTitleRuleInline } from './titleRuleSanitize';

/** @import { AppSettings, ChallengeValues, RuleMatchChallenge, TitleRule } from '../types/settings' */

/**
 * The one profile a challenge's matching rules apply, and the rule naming it.
 *
 * @typedef {{name: string, values: ChallengeValues, rule: TitleRule}} RuleProfile
 */

/**
 * The profile a matching rule list contributes: the one named by the FIRST
 * matching rule that names a profile. Only one profile ever applies to a
 * challenge, because a profile is validated as a whole value set (cross-field
 * rules like exposureTarget >= exposure) and mixing keys from two profiles
 * could assemble a combination neither one allows. A stale/corrupt reference
 * fails closed as a whole: automation never executes a partially sanitized
 * profile.
 *
 * @param {AppSettings} settings
 * @param {TitleRule[]} matches
 * @returns {RuleProfile|null}
 */
const profileFromMatches = (settings, matches) => {
    const rule = matches.find((candidate) => normalizeProfileName(candidate?.profile));
    if (!rule) return null;
    const normalizedProfile = normalizeProfileName(rule.profile);
    if (RESERVED_PROFILE_NAMES.has(normalizedProfile)) return null;

    const stored = readProfilesMap(settings);
    const storedKey = findProfileKey(stored, normalizedProfile);
    if (storedKey === null) return null;
    const values = sanitizeProfileValues(stored[storedKey], true, globalChallengeValues(settings), false);
    if (values === null) return null;
    return { name: storedKey, values, rule };
};

/**
 * The settings the rules matching a challenge contribute, as one sparse map.
 * Walks the matches in list order and, per key, keeps the FIRST value found:
 * each rule's own inline values first, then — for the first rule naming a
 * profile only — that profile's values. So a rule higher in the list wins, and
 * a key it leaves unset falls through to the next matching rule, then to the
 * global default (the caller's job).
 *
 * `suppressProfile` drops the profile layer (a challenge whose rule profile was
 * replaced by a manually applied one).
 *
 * @param {AppSettings} settings
 * @param {RuleMatchChallenge|string|null|undefined} target
 * @param {boolean} [suppressProfile]
 * @returns {{values: ChallengeValues, profile: RuleProfile|null}}
 */
const ruleValuesFor = (settings, target, suppressProfile = false) => {
    const matches = matchingRules(settings.challengeSettings?.titleRules, target);
    const profile = suppressProfile ? null : profileFromMatches(settings, matches);
    /** @type {ChallengeValues} */
    const values = {};
    /** @param {ChallengeValues} source */
    const take = (source) => {
        for (const [key, value] of Object.entries(source)) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = value;
        }
    };
    for (const rule of matches) {
        // Re-validated on read: a hand-edited settings file can hold anything,
        // and a rule with an invalid inline value contributes no inline values.
        const inline = sanitizeTitleRuleInline(rule);
        if (inline) take(inline);
        if (profile && profile.rule === rule) take(profile.values);
    }
    return { values, profile };
};

/**
 * @param {AppSettings} settings
 * @param {unknown} challengeId
 * @returns {boolean}
 */
const isTitleProfileSuppressed = (settings, challengeId) => {
    const id = challengeId === null || challengeId === undefined ? '' : String(challengeId);
    const suppressions = settings.challengeSettings?.titleProfileSuppressions;
    return Boolean(
        id &&
        suppressions &&
        typeof suppressions === 'object' &&
        !Array.isArray(suppressions) &&
        Object.prototype.hasOwnProperty.call(suppressions, id) &&
        suppressions[id] === true,
    );
};

/**
 * `ruleValuesFor` for an id-only caller, honouring its profile suppression.
 *
 * @param {AppSettings} settings
 * @param {unknown} challengeId
 * @param {boolean} [suppressProfile]
 * @returns {ChallengeValues}
 */
const ruleValuesForChallengeId = (
    settings,
    challengeId,
    suppressProfile = isTitleProfileSuppressed(settings, challengeId),
) => ruleValuesFor(settings, challengeTargetForId(settings, challengeId), suppressProfile).values;

/**
 * @param {AppSettings} settings
 * @param {TitleRule} rule
 * @param {unknown} rawProfileValues
 * @returns {boolean}
 */
const titleProfileComposesWithKnownOverrides = (settings, rule, rawProfileValues) => {
    const globalValues = globalChallengeValues(settings);
    const profileValues = sanitizeProfileValues(rawProfileValues, true, globalValues);
    if (profileValues === null) return false;

    const perChallenge = settings.challengeSettings?.perChallenge || {};
    return Object.entries(perChallenge).every(([challengeId, overrides]) => {
        if (isTitleProfileSuppressed(settings, challengeId)) return true;
        // Applicability must use the REAL matcher, not an exact title compare:
        // a contains/starts or class-keyed rule reaches challenges whose title
        // is not the rule's own, and skipping those would let a conflicting
        // profile+override combination save unvalidated.
        if (matchingRules([rule], challengeTargetForId(settings, challengeId)).length === 0) return true;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
        const effective = { ...globalValues, ...profileValues, ...overrides };
        return challengeValueSetIsValid(effective, { ...profileValues, ...overrides }, challengeId);
    });
};

export {
    profileFromMatches,
    ruleValuesFor,
    ruleValuesForChallengeId,
    isTitleProfileSuppressed,
    titleProfileComposesWithKnownOverrides,
};
