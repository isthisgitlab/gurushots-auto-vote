/**
 * Challenge rules: condition matching and the default rule order.
 *
 * Dependency-free on purpose (no zod, no logger) so the renderer can import it
 * for the editor's "sort by default order" action without pulling the settings
 * schema into the bundle (it imports only the dependency-free wallClock).
 * Persistence and value validation live behind the settings.ts facade.
 *
 * A rule carries any mix of conditions — a title (with a match mode), a
 * challenge tag, the challenge type, the photo count, a runtime range in
 * hours, and a close time of day ('HH:MM' as the challenge card shows it, in
 * the app's timezone, any date) — and every condition it carries must hold. A rule with no condition
 * matches nothing. The rules LIST ORDER is the precedence: for each setting,
 * the first matching rule that sets it wins.
 */

import { parseTimeOfDay, timeOfDayIn } from '../scheduling/wallClock';

import type { LooseRecord, RuleMatchChallenge } from '../types/settings';

/**
 * A rule as the matcher reads it: a stored rule, an editor row, or raw input.
 * Every field is re-normalized on read, so nothing about it is trusted.
 */
export type RuleLike = LooseRecord | null | undefined;

/**
 * A rule's conditions, normalized. `null` / '' / [] = not set; `closesAt` is
 * `false` when a value is present but not a strict 'HH:MM' (matches nothing).
 */
interface RuleConditions {
    patterns: string[];
    modes: string[];
    tag: string;
    type: string;
    pics: number | null;
    minHours: number | null;
    maxHours: number | null;
    closesAt: string | null | false;
}

/**
 * A challenge normalized into the keys the conditions compare against.
 */
interface RuleMatchTarget {
    titleKey: string;
    tagKeys: string[];
    typeKey: string;
    pics: number | null;
    runtimeHours: number | null;
    closeTimeOfDay: string | null;
}

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
const normalizeTitle = (title: unknown): string => (typeof title === 'string' ? title.trim().toLowerCase() : '');

// Challenge tags ("Exhibition", "No comm") and types ("default", "flash") are
// API-owned strings, compared trimmed + lowercased like titles.
const normalizeTag = normalizeTitle;

const normalizeTagList = (tags: unknown): string[] =>
    Array.isArray(tags) ? tags.map(normalizeTag).filter(Boolean) : [];

const ruleMatchMode = (rule: RuleLike): string => {
    const match = rule?.match;
    return typeof match === 'string' && TITLE_MATCH_MODES.includes(match) ? match : 'exact';
};

/**
 * The raw title patterns a rule carries: the full `titles` list when present,
 * else the single `title` (which always mirrors the first entry of `titles`).
 * Non-strings are dropped; empties are left for callers to filter.
 */
const titleRuleTitles = (rule: RuleLike): string[] => {
    const titles = rule?.titles;
    const list: unknown[] = Array.isArray(titles) && titles.length > 0 ? titles : [rule?.title];
    return list.filter((title) => typeof title === 'string');
};

/**
 * Normalized, non-empty patterns — what the matcher and the identity key use.
 */
const rulePatterns = (rule: RuleLike): string[] => titleRuleTitles(rule).map(normalizeTitle).filter(Boolean);

const ruleTitleModes = (rule: RuleLike): string[] => {
    const modes = rule?.titleMatchModes;
    const fallback = ruleMatchMode(rule);
    return titleRuleTitles(rule).map((_, index) => {
        const mode = Array.isArray(modes) ? modes[index] : fallback;
        return typeof mode === 'string' && TITLE_MATCH_MODES.includes(mode) ? mode : 'exact';
    });
};

/**
 * A photo-count condition value, or null when absent/out of range.
 */
const normalizeRulePics = (pics: unknown): number | null => {
    if (pics === null || pics === undefined || pics === '') return null;
    const n = Number(pics);
    return Number.isInteger(n) && n >= 1 && n <= MAX_RULE_PICS ? n : null;
};

/**
 * A runtime bound in hours, or null when absent/out of range.
 */
const normalizeRuleHours = (hours: unknown): number | null => {
    if (hours === null || hours === undefined || hours === '') return null;
    const n = Number(hours);
    return Number.isFinite(n) && n > 0 && n <= MAX_RULE_RUNTIME_HOURS ? n : null;
};

/**
 * A close-time condition: null when absent (undefined / null / ''), false when
 * present but not a strict 'HH:MM', else the value. A false rule matches
 * nothing — dropping it would widen the rule to every challenge.
 */
const normalizeRuleClosesAt = (raw: unknown): string | null | false => {
    if (raw === null || raw === undefined || raw === '') return null;
    return parseTimeOfDay(raw) ? (raw as string) : false;
};

/**
 * How long a challenge runs, in hours (`close_time` - `start_time`, both epoch
 * seconds), or null when either is unreadable. A runtime condition fails closed
 * on null, so a payload missing the times never matches a runtime rule.
 */
const challengeRuntimeHours = (challenge: RuleMatchChallenge | null | undefined): number | null => {
    const start = Number(challenge?.start_time);
    const close = Number(challenge?.close_time);
    if (!Number.isFinite(start) || !Number.isFinite(close) || close <= start || start <= 0) return null;
    return (close - start) / 3600;
};

/**
 * The 'HH:MM' a challenge closes at, as its card shows it in `timeZone`, or
 * null when `close_time` is unreadable. A close-time condition fails closed on
 * null.
 */
const challengeCloseTimeOfDay = (challenge: RuleMatchChallenge | null | undefined, timeZone: string): string | null => {
    const close = Number(challenge?.close_time);
    return Number.isFinite(close) && close > 0 ? timeOfDayIn(close, timeZone) : null;
};

/**
 * Normalize a challenge (or a bare title, for callers that only have one) into
 * the keys the conditions compare against. `timeZone` is the app's timezone
 * setting, which the close-time key is read in; pass `withCloseTime: false`
 * when no rule needs it to skip the formatting.
 */
const ruleMatchTarget = (
    target: RuleMatchChallenge | string | null | undefined,
    timeZone: string,
    withCloseTime: boolean = true,
): RuleMatchTarget => {
    const challenge: RuleMatchChallenge = typeof target === 'string' ? { title: target } : target || {};
    return {
        titleKey: normalizeTitle(challenge.title),
        tagKeys: normalizeTagList(challenge.tags),
        typeKey: normalizeTag(challenge.type),
        pics: normalizeRulePics(challenge.max_photo_submits),
        runtimeHours: challengeRuntimeHours(challenge),
        closeTimeOfDay: withCloseTime ? challengeCloseTimeOfDay(challenge, timeZone) : null,
    };
};

/**
 * The conditions a rule carries, normalized. `null` / '' / [] = not set.
 */
const ruleConditions = (rule: RuleLike): RuleConditions => ({
    patterns: titleRuleTitles(rule).map(normalizeTitle).filter(Boolean),
    modes: ruleTitleModes(rule).filter((_, index) => Boolean(normalizeTitle(titleRuleTitles(rule)[index]))),
    tag: normalizeTag(rule?.challengeTag),
    type: normalizeTag(rule?.type),
    pics: normalizeRulePics(rule?.pics),
    minHours: normalizeRuleHours(rule?.minHours),
    maxHours: normalizeRuleHours(rule?.maxHours),
    closesAt: normalizeRuleClosesAt(rule?.closesAt),
});

/** @param conditions */
const hasRuntimeCondition = (conditions: RuleConditions) =>
    conditions.minHours !== null || conditions.maxHours !== null;

/**
 * How many CLASS conditions (everything but the title) a rule carries.
 */
const classConditionCount = (conditions: RuleConditions): number =>
    (conditions.tag ? 1 : 0) +
    (conditions.type ? 1 : 0) +
    (conditions.pics !== null ? 1 : 0) +
    (hasRuntimeCondition(conditions) ? 1 : 0) +
    (typeof conditions.closesAt === 'string' ? 1 : 0);

/**
 * True when the rule carries at least one condition.
 */
const hasRuleCondition = (rule: RuleLike): boolean => {
    const conditions = ruleConditions(rule);
    return conditions.patterns.length > 0 || classConditionCount(conditions) > 0;
};

const titleMatches = (conditions: RuleConditions, titleKey: string): boolean => {
    if (!titleKey) return false;
    return conditions.patterns.some((pattern, index) =>
        conditions.modes[index] === 'contains'
            ? titleKey.includes(pattern)
            : conditions.modes[index] === 'starts'
              ? titleKey.startsWith(pattern)
              : titleKey === pattern,
    );
};

const runtimeMatches = (conditions: RuleConditions, runtimeHours: number | null): boolean => {
    if (runtimeHours === null) return false;
    if (conditions.minHours !== null && runtimeHours < conditions.minHours) return false;
    return conditions.maxHours === null || runtimeHours <= conditions.maxHours;
};

/**
 * Does `rule` match the normalized `target` (from ruleMatchTarget)? Every
 * condition the rule carries must hold; a rule with none matches nothing.
 */
const ruleMatches = (rule: RuleLike, target: RuleMatchTarget): boolean => {
    const conditions = ruleConditions(rule);
    if (conditions.patterns.length === 0 && classConditionCount(conditions) === 0) return false;
    if (conditions.patterns.length > 0 && !titleMatches(conditions, target.titleKey)) return false;
    if (conditions.tag && !target.tagKeys.includes(conditions.tag)) return false;
    if (conditions.type && target.typeKey !== conditions.type) return false;
    if (conditions.pics !== null && target.pics !== conditions.pics) return false;
    if (conditions.closesAt === false) return false;
    if (conditions.closesAt !== null && target.closeTimeOfDay !== conditions.closesAt) return false;
    return !hasRuntimeCondition(conditions) || runtimeMatches(conditions, target.runtimeHours);
};

/**
 * Every rule in `rules` matching a challenge, in list (= precedence) order.
 *
 * @param challenge a challenge, or just its title
 * @param timeZone the app's timezone setting, which close-time conditions read in
 */
const matchingRules = <R extends RuleLike>(
    rules: readonly R[] | null | undefined,
    challenge: RuleMatchChallenge | string | null | undefined,
    timeZone: string,
): R[] => {
    if (!Array.isArray(rules) || rules.length === 0) return [];
    const needsCloseTime = rules.some((rule) => typeof normalizeRuleClosesAt(rule?.closesAt) === 'string');
    const target = ruleMatchTarget(challenge, timeZone, needsCloseTime);
    return rules.filter((rule) => ruleMatches(rule, target));
};

// Title modes ranked by how narrowly they pin one challenge.
const TITLE_MODE_SCORE: Record<string, number> = { exact: 3, starts: 2, contains: 1 };

/**
 * Sort key for the default order, compared element by element, higher first:
 *   1. a rule naming a title outranks every rule that does not — a title names
 *      one challenge, a class condition names dozens;
 *   2. more conditions first (for title rules the match mode weighs in: exact
 *      3, starts 2, contains 1, plus one per class condition);
 *   3. then the longer title pattern (title rules only);
 *   4. then by which class conditions it carries: photo count, then runtime,
 *      then close time, then type, then tag — so "4 photos + 7 days" >
 *      "4 photos" > "7 days". A close-time-only rule has no title, so sorting
 *      puts it below every title rule.
 * For title rules 1–3 reproduce the most-specific-wins ranking, so the
 * ordering migration keeps every existing winner.
 */
const defaultOrderKey = (rule: RuleLike): number[] => {
    const conditions = ruleConditions(rule);
    const hasTitle = conditions.patterns.length > 0;
    const count = classConditionCount(conditions);
    return [
        hasTitle ? 1 : 0,
        (hasTitle ? Math.min(...conditions.modes.map((mode) => TITLE_MODE_SCORE[mode])) : 0) + count,
        Math.max(0, ...conditions.patterns.map((pattern) => pattern.length)),
        conditions.pics !== null ? 1 : 0,
        hasRuntimeCondition(conditions) ? 1 : 0,
        typeof conditions.closesAt === 'string' ? 1 : 0,
        conditions.type ? 1 : 0,
        conditions.tag ? 1 : 0,
    ];
};

const compareDefaultOrder = (a: RuleLike, b: RuleLike): number => {
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
 */
const sortRulesByDefaultOrder = <R extends RuleLike>(rules: readonly R[] | null | undefined): R[] =>
    Array.isArray(rules) ? [...rules].sort(compareDefaultOrder) : [];

export {
    TITLE_MATCH_MODES,
    normalizeTitle,
    normalizeTag,
    titleRuleTitles,
    ruleTitleModes,
    rulePatterns,
    normalizeRulePics,
    normalizeRuleHours,
    normalizeRuleClosesAt,
    challengeRuntimeHours,
    challengeCloseTimeOfDay,
    ruleMatchTarget,
    ruleConditions,
    hasRuleCondition,
    ruleMatches,
    matchingRules,
    sortRulesByDefaultOrder,
};
