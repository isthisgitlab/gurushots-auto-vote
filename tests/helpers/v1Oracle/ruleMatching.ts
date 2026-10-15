/**
 * The 1.x challenge-rule matcher, frozen: which rules match a challenge. A copy of `settings/challengeRules.ts` and the
 * wall-clock reads it makes, as of the last 1.x release; it never follows the live code.
 */

import { isPlainObject } from '../../../src/ts/plainObject';

/** What a rule is matched on: a challenge payload, or just a title. */
export type MatchTarget = {
    id?: string | number;
    title?: unknown;
    tags?: unknown;
    type?: unknown;
    max_photo_submits?: unknown;
    start_time?: unknown;
    close_time?: unknown;
};

/** A stored rule: whatever the file holds. */
type RuleLike = Record<string, unknown> | null | undefined;

type RuleConditions = {
    patterns: string[];
    modes: string[];
    tag: string;
    type: string;
    pics: number | null;
    minHours: number | null;
    maxHours: number | null;
    closeTimes: string[] | null | false;
};

type RuleMatchTarget = {
    titleKey: string;
    tagKeys: string[];
    typeKey: string;
    pics: number | null;
    runtimeHours: number | null;
    closeTimeOfDay: string | null;
};

const TITLE_MATCH_MODES = ['exact', 'contains', 'starts'];
const MAX_RULE_PICS = 10;
const MAX_RULE_RUNTIME_HOURS = 2000;

const formatterCache: Map<string, Intl.DateTimeFormat> = new Map();

const partsOf = (epochSec: number, timeZone: string): Record<string, string> => {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatterCache.set(timeZone, formatter);
    }
    const byType: Record<string, string> = {};
    for (const part of formatter.formatToParts(epochSec * 1000)) byType[part.type] = part.value;
    return byType;
};

const parseTimeOfDay = (str: unknown): { hours: number; minutes: number } | null => {
    if (typeof str !== 'string') return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str);
    return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

// An unknown zone (and 'local') reads the device clock, as the challenge card does.
const timeOfDayIn = (epochSec: number, timeZone: string): string => {
    if (timeZone !== 'local') {
        try {
            const { hour, minute } = partsOf(epochSec, timeZone);
            return `${hour}:${minute}`;
        } catch {
            // Unknown zone: the device clock.
        }
    }
    const date = new Date(epochSec * 1000);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

const normalizeTitle = (title: unknown): string => (typeof title === 'string' ? title.trim().toLowerCase() : '');
const normalizeTag = normalizeTitle;

const normalizeTagList = (tags: unknown): string[] =>
    Array.isArray(tags) ? tags.map(normalizeTag).filter(Boolean) : [];

const field = (rule: RuleLike, key: string): unknown => (isPlainObject(rule) ? rule[key] : undefined);

const ruleMatchMode = (rule: RuleLike): string => {
    const match = field(rule, 'match');
    return typeof match === 'string' && TITLE_MATCH_MODES.includes(match) ? match : 'exact';
};

const titleRuleTitles = (rule: RuleLike): string[] => {
    const titles = field(rule, 'titles');
    const list: unknown[] = Array.isArray(titles) && titles.length > 0 ? titles : [field(rule, 'title')];
    return list.filter((title): title is string => typeof title === 'string');
};

const ruleTitleModes = (rule: RuleLike): string[] => {
    const modes = field(rule, 'titleMatchModes');
    const fallback = ruleMatchMode(rule);
    return titleRuleTitles(rule).map((_, index) => {
        const mode: unknown = Array.isArray(modes) ? modes[index] : fallback;
        return typeof mode === 'string' && TITLE_MATCH_MODES.includes(mode) ? mode : 'exact';
    });
};

const normalizeRulePics = (pics: unknown): number | null => {
    if (pics === null || pics === undefined || pics === '') return null;
    const n = Number(pics);
    return Number.isInteger(n) && n >= 1 && n <= MAX_RULE_PICS ? n : null;
};

const normalizeRuleHours = (hours: unknown): number | null => {
    if (hours === null || hours === undefined || hours === '') return null;
    const n = Number(hours);
    return Number.isFinite(n) && n > 0 && n <= MAX_RULE_RUNTIME_HOURS ? n : null;
};

const normalizeRuleClosesAt = (raw: unknown): string | null | false => {
    if (raw === null || raw === undefined || raw === '') return null;
    return typeof raw === 'string' && parseTimeOfDay(raw) ? raw : false;
};

const normalizeRuleCloseTimes = (rule: RuleLike): string[] | null | false => {
    const raw = field(rule, 'closesAtTimes');
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) return false;
    const times = new Set<string>();
    const entries: unknown[] = Array.isArray(raw) ? raw : [];
    for (const entry of entries) {
        if (typeof entry !== 'string') return false;
        const time = entry.trim();
        if (time === '') continue;
        if (!parseTimeOfDay(time)) return false;
        times.add(time);
    }
    if (times.size > 0) return [...times];
    const single = normalizeRuleClosesAt(field(rule, 'closesAt'));
    return single === null || single === false ? single : [single];
};

const challengeRuntimeHours = (challenge: MatchTarget | null | undefined): number | null => {
    const start = Number(challenge?.start_time);
    const close = Number(challenge?.close_time);
    if (!Number.isFinite(start) || !Number.isFinite(close) || close <= start || start <= 0) return null;
    return (close - start) / 3600;
};

const challengeCloseTimeOfDay = (challenge: MatchTarget | null | undefined, timeZone: string): string | null => {
    const close = Number(challenge?.close_time);
    return Number.isFinite(close) && close > 0 ? timeOfDayIn(close, timeZone) : null;
};

const ruleMatchTarget = (
    target: MatchTarget | string | null | undefined,
    timeZone: string,
    withCloseTime: boolean,
): RuleMatchTarget => {
    const challenge: MatchTarget = typeof target === 'string' ? { title: target } : target || {};
    return {
        titleKey: normalizeTitle(challenge.title),
        tagKeys: normalizeTagList(challenge.tags),
        typeKey: normalizeTag(challenge.type),
        pics: normalizeRulePics(challenge.max_photo_submits),
        runtimeHours: challengeRuntimeHours(challenge),
        closeTimeOfDay: withCloseTime ? challengeCloseTimeOfDay(challenge, timeZone) : null,
    };
};

const ruleConditions = (rule: RuleLike): RuleConditions => ({
    patterns: titleRuleTitles(rule).map(normalizeTitle).filter(Boolean),
    modes: ruleTitleModes(rule).filter((_, index) => Boolean(normalizeTitle(titleRuleTitles(rule)[index]))),
    tag: normalizeTag(field(rule, 'challengeTag')),
    type: normalizeTag(field(rule, 'type')),
    pics: normalizeRulePics(field(rule, 'pics')),
    minHours: normalizeRuleHours(field(rule, 'minHours')),
    maxHours: normalizeRuleHours(field(rule, 'maxHours')),
    closeTimes: normalizeRuleCloseTimes(rule),
});

const hasRuntimeCondition = (conditions: RuleConditions) =>
    conditions.minHours !== null || conditions.maxHours !== null;

const classConditionCount = (conditions: RuleConditions): number =>
    (conditions.tag ? 1 : 0) +
    (conditions.type ? 1 : 0) +
    (conditions.pics !== null ? 1 : 0) +
    (hasRuntimeCondition(conditions) ? 1 : 0) +
    (Array.isArray(conditions.closeTimes) ? 1 : 0);

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

const ruleMatches = (rule: RuleLike, target: RuleMatchTarget): boolean => {
    const conditions = ruleConditions(rule);
    if (conditions.patterns.length === 0 && classConditionCount(conditions) === 0) return false;
    if (conditions.patterns.length > 0 && !titleMatches(conditions, target.titleKey)) return false;
    if (conditions.tag && !target.tagKeys.includes(conditions.tag)) return false;
    if (conditions.type && target.typeKey !== conditions.type) return false;
    if (conditions.pics !== null && target.pics !== conditions.pics) return false;
    if (conditions.closeTimes === false) return false;
    if (conditions.closeTimes !== null && !conditions.closeTimes.includes(target.closeTimeOfDay ?? '')) return false;
    return !hasRuntimeCondition(conditions) || runtimeMatches(conditions, target.runtimeHours);
};

/** Every rule matching a challenge, in list (= precedence) order. */
const matchingRules = <R extends RuleLike>(
    rules: readonly R[] | null | undefined,
    challenge: MatchTarget | string | null | undefined,
    timeZone: string,
): R[] => {
    if (!Array.isArray(rules) || rules.length === 0) return [];
    const needsCloseTime = rules.some((rule) => Array.isArray(normalizeRuleCloseTimes(rule)));
    const target = ruleMatchTarget(challenge, timeZone, needsCloseTime);
    return rules.filter((rule) => ruleMatches(rule, target));
};

export { matchingRules, normalizeTitle, ruleConditions };
