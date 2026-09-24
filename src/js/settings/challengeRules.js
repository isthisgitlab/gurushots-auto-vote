/**
 * Challenge rules: condition matching and the default rule order.
 *
 * Dependency-free on purpose (no zod, no logger) so the renderer can import it
 * for the editor's "sort by default order" action without pulling the settings
 * schema into the bundle. Persistence and value validation live in settings.js.
 *
 * A rule carries any mix of conditions — a title (with a match mode), a
 * challenge tag, the challenge type, the photo count, and a runtime range in
 * hours — and every condition it carries must hold. A rule with no condition
 * matches nothing. The rules LIST ORDER is the precedence: for each setting,
 * the first matching rule that sets it wins.
 */

// How a rule's title is compared. 'exact' is the default; a rule without a
// `match` key compares exactly.
const TITLE_MATCH_MODES = ['exact', 'contains', 'starts'];

// A challenge carries at most a handful of submissions; the ceiling is a
// defense-in-depth bound on a hand-edited file, not a real API limit.
const MAX_RULE_PICS = 10;

// Upper bound for a runtime condition. The longest live challenges (weeks-long
// exhibitions) run ~516h; 2000h (~83 days) leaves generous headroom.
const MAX_RULE_RUNTIME_HOURS = 2000;

// Stable match key for a title: trimmed + lowercased. The same challenge recurs
// with the same title (but a new id) on each rotation.
const normalizeTitle = (title) => (typeof title === 'string' ? title.trim().toLowerCase() : '');

// Challenge tags ("Exhibition", "No comm") and types ("default", "flash") are
// API-owned strings, compared trimmed + lowercased like titles.
const normalizeTag = normalizeTitle;

const normalizeTagList = (tags) => (Array.isArray(tags) ? tags.map(normalizeTag).filter(Boolean) : []);

const ruleMatchMode = (rule) => (TITLE_MATCH_MODES.includes(rule?.match) ? rule.match : 'exact');

/**
 * The raw title patterns a rule carries: the full `titles` list when present,
 * else the single `title` (which always mirrors the first entry of `titles`).
 * Non-strings are dropped; empties are left for callers to filter.
 *
 * @param {object} rule
 * @returns {string[]}
 */
const titleRuleTitles = (rule) => {
    const list = Array.isArray(rule?.titles) && rule.titles.length > 0 ? rule.titles : [rule?.title];
    return list.filter((title) => typeof title === 'string');
};

// Normalized, non-empty patterns — what the matcher and the identity key use.
const rulePatterns = (rule) => titleRuleTitles(rule).map(normalizeTitle).filter(Boolean);

/** A photo-count condition value, or null when absent/out of range. */
const normalizeRulePics = (pics) => {
    if (pics === null || pics === undefined || pics === '') return null;
    const n = Number(pics);
    return Number.isInteger(n) && n >= 1 && n <= MAX_RULE_PICS ? n : null;
};

/** A runtime bound in hours, or null when absent/out of range. */
const normalizeRuleHours = (hours) => {
    if (hours === null || hours === undefined || hours === '') return null;
    const n = Number(hours);
    return Number.isFinite(n) && n > 0 && n <= MAX_RULE_RUNTIME_HOURS ? n : null;
};

/**
 * How long a challenge runs, in hours (`close_time` - `start_time`, both epoch
 * seconds), or null when either is unreadable. A runtime condition fails closed
 * on null, so a payload missing the times never matches a runtime rule.
 */
const challengeRuntimeHours = (challenge) => {
    const start = Number(challenge?.start_time);
    const close = Number(challenge?.close_time);
    if (!Number.isFinite(start) || !Number.isFinite(close) || close <= start || start <= 0) return null;
    return (close - start) / 3600;
};

/**
 * Normalize a challenge (or a bare title, for callers that only have one) into
 * the keys the conditions compare against.
 *
 * @param {object|string} target
 */
const ruleMatchTarget = (target) => {
    const challenge = typeof target === 'string' ? { title: target } : target || {};
    return {
        titleKey: normalizeTitle(challenge.title),
        tagKeys: normalizeTagList(challenge.tags),
        typeKey: normalizeTag(challenge.type),
        pics: normalizeRulePics(challenge.max_photo_submits),
        runtimeHours: challengeRuntimeHours(challenge),
    };
};

/**
 * The conditions a rule carries, normalized. `null` / '' / [] = not set.
 *
 * @param {object} rule
 */
const ruleConditions = (rule) => ({
    patterns: rulePatterns(rule),
    mode: ruleMatchMode(rule),
    tag: normalizeTag(rule?.challengeTag),
    type: normalizeTag(rule?.type),
    pics: normalizeRulePics(rule?.pics),
    minHours: normalizeRuleHours(rule?.minHours),
    maxHours: normalizeRuleHours(rule?.maxHours),
});

const hasRuntimeCondition = (conditions) => conditions.minHours !== null || conditions.maxHours !== null;

/** How many CLASS conditions (everything but the title) a rule carries. */
const classConditionCount = (conditions) =>
    (conditions.tag ? 1 : 0) +
    (conditions.type ? 1 : 0) +
    (conditions.pics !== null ? 1 : 0) +
    (hasRuntimeCondition(conditions) ? 1 : 0);

/** True when the rule carries at least one condition. */
const hasRuleCondition = (rule) => {
    const conditions = ruleConditions(rule);
    return conditions.patterns.length > 0 || classConditionCount(conditions) > 0;
};

const titleMatches = (conditions, titleKey) => {
    if (!titleKey) return false;
    return conditions.patterns.some((pattern) =>
        conditions.mode === 'contains'
            ? titleKey.includes(pattern)
            : conditions.mode === 'starts'
              ? titleKey.startsWith(pattern)
              : titleKey === pattern,
    );
};

const runtimeMatches = (conditions, runtimeHours) => {
    if (runtimeHours === null) return false;
    if (conditions.minHours !== null && runtimeHours < conditions.minHours) return false;
    return conditions.maxHours === null || runtimeHours <= conditions.maxHours;
};

/**
 * Does `rule` match the normalized `target` (from ruleMatchTarget)? Every
 * condition the rule carries must hold; a rule with none matches nothing.
 */
const ruleMatches = (rule, target) => {
    const conditions = ruleConditions(rule);
    if (conditions.patterns.length === 0 && classConditionCount(conditions) === 0) return false;
    if (conditions.patterns.length > 0 && !titleMatches(conditions, target.titleKey)) return false;
    if (conditions.tag && !target.tagKeys.includes(conditions.tag)) return false;
    if (conditions.type && target.typeKey !== conditions.type) return false;
    if (conditions.pics !== null && target.pics !== conditions.pics) return false;
    return !hasRuntimeCondition(conditions) || runtimeMatches(conditions, target.runtimeHours);
};

/**
 * Every rule in `rules` matching a challenge, in list (= precedence) order.
 *
 * @param {Array<object>} rules
 * @param {object|string} challenge a challenge, or just its title
 * @returns {Array<object>}
 */
const matchingRules = (rules, challenge) => {
    if (!Array.isArray(rules) || rules.length === 0) return [];
    const target = ruleMatchTarget(challenge);
    return rules.filter((rule) => ruleMatches(rule, target));
};

// Title modes ranked by how narrowly they pin one challenge.
const TITLE_MODE_SCORE = { exact: 3, starts: 2, contains: 1 };

/**
 * Sort key for the default order, compared element by element, higher first:
 *   1. a rule naming a title outranks every rule that does not — a title names
 *      one challenge, a class condition names dozens;
 *   2. more conditions first (for title rules the match mode weighs in: exact
 *      3, starts 2, contains 1, plus one per class condition);
 *   3. then the longer title pattern (title rules only);
 *   4. then by which class conditions it carries: photo count, then runtime,
 *      then type, then tag — so "4 photos + 7 days" > "4 photos" > "7 days".
 * For title rules 1–3 reproduce the specificity ranking the matcher used to
 * apply, so an ordering migration keeps every existing winner.
 */
const defaultOrderKey = (rule) => {
    const conditions = ruleConditions(rule);
    const hasTitle = conditions.patterns.length > 0;
    const count = classConditionCount(conditions);
    return [
        hasTitle ? 1 : 0,
        (hasTitle ? TITLE_MODE_SCORE[conditions.mode] : 0) + count,
        Math.max(0, ...conditions.patterns.map((pattern) => pattern.length)),
        conditions.pics !== null ? 1 : 0,
        hasRuntimeCondition(conditions) ? 1 : 0,
        conditions.type ? 1 : 0,
        conditions.tag ? 1 : 0,
    ];
};

const compareDefaultOrder = (a, b) => {
    const left = defaultOrderKey(a);
    const right = defaultOrderKey(b);
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
};

/**
 * A copy of `rules` in the default order (see defaultOrderKey). Stable, so
 * rules that rank equal keep their relative order.
 *
 * @param {Array<object>} rules
 * @returns {Array<object>}
 */
const sortRulesByDefaultOrder = (rules) => (Array.isArray(rules) ? [...rules].sort(compareDefaultOrder) : []);

module.exports = {
    TITLE_MATCH_MODES,
    MAX_RULE_PICS,
    MAX_RULE_RUNTIME_HOURS,
    normalizeTitle,
    normalizeTag,
    normalizeTagList,
    ruleMatchMode,
    titleRuleTitles,
    rulePatterns,
    normalizeRulePics,
    normalizeRuleHours,
    challengeRuntimeHours,
    ruleMatchTarget,
    ruleConditions,
    hasRuleCondition,
    ruleMatches,
    matchingRules,
    sortRulesByDefaultOrder,
};
