/**
 * Challenge rules as a persisted, rotation-proof settings layer: reading and
 * saving the ordered rule list, and the rule-aware resolvers callers use —
 * a single rule setting, the join opt-in, the inherited title profile, and the
 * tag-list / ignore-words effective values.
 */

const logger = require('../logger');
const { ruleConditions, matchingRules } = require('./challengeRules');
const { loadSettings, saveSettings } = require('./persistence');
const { ensureChallengeSettings } = require('./defaults');
const { readProfilesMap, profileNameForLog } = require('./profileStore');
const { factsForChallengeId } = require('./challengeFacts');
const { MAX_TITLE_RULES, sanitizeTitleRule, titleRuleKey, ruleLogLabel } = require('./titleRuleSanitize');
const {
    profileFromMatches,
    ruleValuesFor,
    isTitleProfileSuppressed,
    titleProfileComposesWithKnownOverrides,
} = require('./ruleResolution');
const { getEffectiveSetting } = require('./challengeOverrides');

/**
 * Setting keys whose rule contribution is merged as a tag union. Named
 * profiles resolve as an inherited settings layer instead.
 */
const TITLE_RULE_TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];

/**
 * Order-preserving union of two tag lists with the base first. A null /
 * non-array base is treated as empty so the result is always a real array
 * when `extra` has entries.
 */
const unionTags = (base, extra) => {
    const out = [];
    const seen = new Set();
    // `extra` is always an array (the caller checks it); only `base` can be null.
    for (const list of [Array.isArray(base) ? base : [], extra]) {
        for (const tag of list) {
            if (typeof tag !== 'string') continue;
            if (seen.has(tag)) continue;
            seen.add(tag);
            out.push(tag);
        }
    }
    return out;
};

/**
 * Get the saved challenge rules. Tolerates a settings file whose
 * challengeSettings block has no titleRules array (loadSettings shallow-merges
 * challengeSettings whole).
 */
const getTitleRules = () => {
    const settings = loadSettings();
    const rules = settings.challengeSettings?.titleRules;
    return Array.isArray(rules) ? rules : [];
};

/**
 * Public per-setting resolver for callers holding a challenge payload (the join
 * pass resolves un-joined candidates, which have no id-keyed state). Returns
 * `{ value }` from the first matching rule that sets the key (see
 * `ruleValuesFor` in settings/ruleResolution.js), or null when none does.
 *
 * @param {string} key
 * @param {object|string} target
 * @returns {{value: *}|null}
 */
const resolveRuleSetting = (key, target) => {
    const { values } = ruleValuesFor(loadSettings(), target);
    return Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key] } : null;
};

/**
 * Whether the rules explicitly opt a candidate into auto-join strongly enough
 * to bypass the join TYPE filters: they resolve `autoJoin` to true (inline or
 * via the profile), or the applying profile comes from a rule naming a title or
 * a challenge tag — the user naming this challenge and handing it a tactic.
 * A profile from a rule keyed only on type / photo count / runtime does not
 * bypass: "every 4-photo challenge votes like this" says how, not whether.
 *
 * @param {object} challenge
 * @returns {boolean}
 */
const hasRuleJoinOptIn = (challenge) => {
    const { values, profile } = ruleValuesFor(loadSettings(), challenge);
    if (values.autoJoin === true) return true;
    if (!profile) return false;
    const conditions = ruleConditions(profile.rule);
    return conditions.patterns.length > 0 || Boolean(conditions.tag);
};

// Bound a user-supplied title before it reaches a log line so an oversized
// value can't produce a huge log event (defense in depth for log shipping).
const _titleForLog = (title) => (title.length > 80 ? `${title.slice(0, 80)}…` : title);

/**
 * Sanitize every rule and de-dupe on the whole CONDITION, not the title alone:
 * "abc"/exact and "abc"/contains are different rules, and a title-less rule has
 * no title to key on at all. Last wins within one identical condition, at the
 * first one's position. Returns the rule list, or null (logged) on the first
 * rejected rule.
 */
const _sanitizedUniqueRules = (rules, storedProfiles) => {
    const byKey = new Map();
    for (const rule of rules) {
        const result = sanitizeTitleRule(rule, storedProfiles);
        if (!result.valid) {
            const detail = result.requestedProfile
                ? `unknown profile "${profileNameForLog(result.requestedProfile)}"`
                : `invalid or over-length values`;
            logger
                .withCategory('settings')
                .error(`Title rule rejected for "${_titleForLog(result.title)}": ${detail}`, null);
            return null;
        }
        if (result.rule) byKey.set(titleRuleKey(result.rule), result.rule);
    }
    return Array.from(byKey.values());
};

/**
 * Persist the challenge rules, in the given order — the order is the
 * precedence. A rule may add tags, inherit a named profile, override settings
 * inline, or any mix. Sanitizes input: trims titles, validates conditions and
 * tag lists against the schema, resolves profile names case-insensitively,
 * drops no-op rules, and de-dupes by the whole match condition (last wins, at
 * the first one's position).
 */
const setTitleRules = (rules) => {
    if (!Array.isArray(rules)) {
        logger.withCategory('settings').error('setTitleRules expects an array', null);
        return false;
    }
    if (rules.length > MAX_TITLE_RULES) {
        logger
            .withCategory('settings')
            .error(`setTitleRules rejected: ${rules.length} rules exceeds the ${MAX_TITLE_RULES} cap`, null);
        return false;
    }

    const settings = loadSettings();
    const storedProfiles = readProfilesMap(settings);
    const sanitized = _sanitizedUniqueRules(rules, storedProfiles);
    if (sanitized === null) return false;

    for (const rule of sanitized) {
        if (rule.profile && !titleProfileComposesWithKnownOverrides(settings, rule, storedProfiles[rule.profile])) {
            logger
                .withCategory('settings')
                .error(
                    `Title profile conflicts with manual overrides for "${_titleForLog(ruleLogLabel(rule, rule.title))}"`,
                    null,
                );
            return false;
        }
    }

    ensureChallengeSettings(settings).titleRules = sanitized;
    // The list is saved in the order the user gave, which IS the precedence, so
    // the one-time ordering migration must never re-sort it afterwards (a fresh
    // install saves before any file exists for that migration to have flagged).
    settings._challengeRulesOrderedV1 = true;
    return saveSettings(settings);
};

/**
 * Public read model for the renderer: returns the sanitized profile inherited
 * by a challenge, or null when nothing matches.
 *
 * Accepts a challenge object or a bare title. With only a title, a rule keyed
 * on tag / type / photo count / runtime can still resolve when `challengeId` is
 * given, because those facts come from the remembered active-challenge list.
 *
 * @param {object|string} target
 * @param {string|number|null} [challengeId]
 */
const getTitleProfile = (target, challengeId = null) => {
    const settings = loadSettings();
    const challenge = typeof target === 'string' ? { title: target } : { ...target };
    const hasId = challengeId !== null && challengeId !== undefined;
    if (hasId) {
        // Fill only what the caller did not supply, so an explicit payload wins.
        for (const [key, value] of Object.entries(factsForChallengeId(challengeId))) {
            if (challenge[key] === undefined) challenge[key] = value;
        }
    }
    const matched = profileFromMatches(settings, matchingRules(settings.challengeSettings?.titleRules, challenge));
    if (!matched) return null;
    const profile = { name: matched.name, values: matched.values };
    return hasId ? { ...profile, suppressed: isTitleProfileSuppressed(settings, challengeId) } : profile;
};

/**
 * Effective value for one of the rule-scoped tag lists. Starts from the
 * id-keyed effective value (per-challenge override or global default) and, when
 * a rule matches, unions that rule's tags on top — so a recurring challenge
 * picks up its tags by rule regardless of its rotating id.
 *
 * Falls back to plain getEffectiveSetting for any non-tag key, and preserves
 * the null "no filter" sentinel when there is no rule to contribute tags.
 */
const getEffectiveTagSetting = (settingKey, challenge) => {
    const challengeId = challenge?.id != null ? String(challenge.id) : null;
    const base = getEffectiveSetting(settingKey, challengeId);
    if (!TITLE_RULE_TAG_KEYS.includes(settingKey)) return base;

    // Pass the whole challenge, not just its title: a rule may be keyed on any
    // of the challenge's own facts, and a joined challenge carries them in the
    // payload. The first matching rule that lists tags for this key wins.
    const rule = matchingRules(getTitleRules(), challenge).find(
        (candidate) => Array.isArray(candidate?.[settingKey]) && candidate[settingKey].length > 0,
    );
    if (!rule) return base;

    return unionTags(base, rule[settingKey]);
};

/**
 * The ignore-words list for a challenge title, or null when empty.
 *
 * Thin wrapper over getEffectiveSetting (master -> profile -> per-challenge) so
 * both the fill and join paths read it the same way without either importing
 * the other. Returns null rather than [] because the picker treats null as
 * "no list" and skips the Set construction entirely.
 *
 * @param {object} challenge
 * @returns {Array<string>|null}
 */
const getEffectiveIgnoreTitleWords = (challenge) => {
    const challengeId = challenge?.id != null ? String(challenge.id) : null;
    const words = getEffectiveSetting('ignoreTitleWords', challengeId);
    return Array.isArray(words) && words.length > 0 ? words : null;
};

module.exports = {
    getTitleRules,
    setTitleRules,
    resolveRuleSetting,
    hasRuleJoinOptIn,
    getTitleProfile,
    getEffectiveTagSetting,
    getEffectiveIgnoreTitleWords,
};
