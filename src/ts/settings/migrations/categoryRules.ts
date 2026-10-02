import * as logger from '../../logger';
import { ruleConditions, sortRulesByDefaultOrder } from '../challengeRules';
import { readProfilesMap } from '../profileStore';
import { ruleLogLabel } from '../titleRuleSanitize';

import type { AppSettings, ChallengeValues, LooseRecord, TitleRule } from '../../types/settings';

// Rules are evaluated in list order, and category rules (keyed on challenge
// type / photo count, join timing only) live in that same list. This one-time
// pass puts the saved title rules into the default order — which reproduces
// the outcome of the specificity ranking they were written against — and
// appends each category rule as a title-less rule, most conditions first,
// below every title rule, keeping the precedence they already had.
const CATEGORY_RULE_KEYS = ['type', 'pics', 'autoJoinWithinHoursOfEnd', 'autoJoinAfterPercentElapsed'];

// Keys whose fall-through from a lower rule could newly spend coins or photos.
const SPENDING_RULE_KEYS = ['autoJoin', 'autoFill'];

/**
 * A stored profile's raw values by exact name, or {} when absent/corrupt. A
 * rule without a profile name has none — never the profile literally named
 * "undefined" that a bare property lookup would coerce it to.
 */
const _ownValues = (map: Record<string, ChallengeValues>, name: unknown): ChallengeValues =>
    (typeof name === 'string' && Object.prototype.hasOwnProperty.call(map, name) && map[name]) || {};

// False only when two rules provably never match the same challenge: disjoint
// exact titles, or different types / photo counts. Anything else may overlap.
const _rulesMayOverlap = (a: TitleRule, b: TitleRule): boolean => {
    const x = ruleConditions(a);
    const y = ruleConditions(b);
    const bothExact =
        x.modes.every((mode) => mode === 'exact') &&
        y.modes.every((mode) => mode === 'exact') &&
        x.patterns.length > 0 &&
        y.patterns.length > 0;
    if (bothExact && !x.patterns.some((pattern) => y.patterns.includes(pattern))) return false;
    if (x.type && y.type && x.type !== y.type) return false;
    return x.pics === null || y.pics === null || x.pics === y.pics;
};

/**
 * A key the higher title rule leaves unset falls through to the next matching
 * rule, which a blob configured under most-specific-wins semantics may not
 * expect. Warn about every pair where that fall-through could switch
 * auto-join or auto-submit ON, so the user can review the order.
 */
const _warnAboutSpendingFallThrough = (titleRules: TitleRule[], profiles: Record<string, ChallengeValues>) => {
    const log = logger.withCategory('settings');
    titleRules.forEach((higher, index) => {
        const higherProfile = _ownValues(profiles, higher.profile);
        for (const lower of titleRules.slice(index + 1)) {
            if (!_rulesMayOverlap(higher, lower)) continue;
            // Only the first profile along the matches applies, so a lower
            // rule's profile is reachable only when the higher one names none.
            const lowerProfile = higher.profile ? {} : _ownValues(profiles, lower.profile);
            const keys = SPENDING_RULE_KEYS.filter(
                (key) =>
                    !Object.prototype.hasOwnProperty.call(higher, key) &&
                    !Object.prototype.hasOwnProperty.call(higherProfile, key) &&
                    (lower[key] === true ||
                        (!Object.prototype.hasOwnProperty.call(lower, key) && lowerProfile[key] === true)),
            );
            if (keys.length === 0) continue;
            log.warning(
                `Challenge rules: "${ruleLogLabel(lower, lower.title)}" can also turn ${keys.join('/')} on for challenges matched by "${ruleLogLabel(higher, higher.title)}" — review the rule order`,
                null,
            );
        }
    });
};

/**
 * Category rules as title-less challenge rules, most conditions first.
 */
const _categoryRulesAsChallengeRules = (categoryRules: unknown[]): TitleRule[] =>
    categoryRules
        .filter((rule): rule is LooseRecord => Boolean(rule) && typeof rule === 'object')
        .map((rule) => {
            const next: TitleRule = { title: '', mustIncludeTags: [], shouldIncludeTags: [] };
            for (const key of CATEGORY_RULE_KEYS) {
                if (Object.prototype.hasOwnProperty.call(rule, key)) next[key] = rule[key];
            }
            return next;
        })
        .sort((a, b) => Number('pics' in b) + Number('type' in b) - (Number('pics' in a) + Number('type' in a)));

export const migrateCategoryRulesIntoChallengeRules = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._challengeRulesOrderedV1) return false;
    const challengeSettings = mergedSettings.challengeSettings;
    if (challengeSettings && typeof challengeSettings === 'object') {
        const titleRules = Array.isArray(challengeSettings.titleRules) ? challengeSettings.titleRules : [];
        const categoryRules = Array.isArray(challengeSettings.categoryRules) ? challengeSettings.categoryRules : [];
        const converted = _categoryRulesAsChallengeRules(categoryRules);
        const ordered = sortRulesByDefaultOrder(titleRules).filter((rule) => rule && typeof rule === 'object');
        _warnAboutSpendingFallThrough(ordered, readProfilesMap(mergedSettings));
        challengeSettings.titleRules = [...ordered, ...converted];
        delete challengeSettings.categoryRules;
        if (converted.length > 0) {
            logger
                .withCategory('settings')
                .info(`Moved ${converted.length} category rule(s) into the challenge rules list`, null);
        }
    }
    mergedSettings._challengeRulesOrderedV1 = true;
    return true;
};
