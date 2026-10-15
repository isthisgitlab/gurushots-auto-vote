/**
 * The part of the 1.x challenge-rule logic the category-rule migration needs, frozen: how a rule's conditions are
 * normalized and the default order rules are sorted into.
 */

import { isPlainObject } from '../../plainObject';

const TITLE_MATCH_MODES = ['exact', 'contains', 'starts'];
const MAX_RULE_PICS = 10;
const MAX_RULE_RUNTIME_HOURS = 2000;
const STRICT_TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

type RuleConditions = {
    patterns: string[];
    modes: string[];
    tag: string;
    type: string;
    pics: number | null;
    hasRuntime: boolean;
    closeTimes: string[] | null | false;
};

// A rule is whatever the file holds; only an object has fields.
const field = (rule: unknown, key: string): unknown => (isPlainObject(rule) ? rule[key] : undefined);

const normalizeTitle = (title: unknown): string => (typeof title === 'string' ? title.trim().toLowerCase() : '');

const titleRuleTitles = (rule: unknown): string[] => {
    const titles = field(rule, 'titles');
    const list: unknown[] = Array.isArray(titles) && titles.length > 0 ? titles : [field(rule, 'title')];
    return list.filter((title) => typeof title === 'string');
};

const ruleTitleModes = (rule: unknown): string[] => {
    const modes = field(rule, 'titleMatchModes');
    const match = field(rule, 'match');
    const fallback = typeof match === 'string' && TITLE_MATCH_MODES.includes(match) ? match : 'exact';
    return titleRuleTitles(rule).map((_, index) => {
        const mode = Array.isArray(modes) ? modes[index] : fallback;
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
    return typeof raw === 'string' && STRICT_TIME_OF_DAY.test(raw) ? raw : false;
};

const normalizeRuleCloseTimes = (rule: unknown): string[] | null | false => {
    const raw = field(rule, 'closesAtTimes');
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) return false;
    const times = new Set<string>();
    for (const entry of (raw ?? []) as unknown[]) {
        if (typeof entry !== 'string') return false;
        const time = entry.trim();
        if (time === '') continue;
        if (!STRICT_TIME_OF_DAY.test(time)) return false;
        times.add(time);
    }
    if (times.size > 0) return [...times];
    const single = normalizeRuleClosesAt(field(rule, 'closesAt'));
    return single === null || single === false ? single : [single];
};

const ruleConditions = (rule: unknown): RuleConditions => {
    const titles = titleRuleTitles(rule);
    return {
        patterns: titles.map(normalizeTitle).filter(Boolean),
        modes: ruleTitleModes(rule).filter((_, index) => Boolean(normalizeTitle(titles[index]))),
        tag: normalizeTitle(field(rule, 'challengeTag')),
        type: normalizeTitle(field(rule, 'type')),
        pics: normalizeRulePics(field(rule, 'pics')),
        hasRuntime:
            normalizeRuleHours(field(rule, 'minHours')) !== null ||
            normalizeRuleHours(field(rule, 'maxHours')) !== null,
        closeTimes: normalizeRuleCloseTimes(rule),
    };
};

const classConditionCount = (conditions: RuleConditions): number =>
    (conditions.tag ? 1 : 0) +
    (conditions.type ? 1 : 0) +
    (conditions.pics !== null ? 1 : 0) +
    (conditions.hasRuntime ? 1 : 0) +
    (Array.isArray(conditions.closeTimes) ? 1 : 0);

// Title modes ranked by how narrowly they pin one challenge.
const TITLE_MODE_SCORE: Record<string, number> = { exact: 3, starts: 2, contains: 1 };

// Sort key for the default order, compared element by element, higher first.
const defaultOrderKey = (rule: unknown): number[] => {
    const conditions = ruleConditions(rule);
    const hasTitle = conditions.patterns.length > 0;
    return [
        hasTitle ? 1 : 0,
        (hasTitle ? Math.min(...conditions.modes.map((mode) => TITLE_MODE_SCORE[mode])) : 0) +
            classConditionCount(conditions),
        Math.max(0, ...conditions.patterns.map((pattern) => pattern.length)),
        conditions.pics !== null ? 1 : 0,
        conditions.hasRuntime ? 1 : 0,
        Array.isArray(conditions.closeTimes) ? 1 : 0,
        conditions.type ? 1 : 0,
        conditions.tag ? 1 : 0,
    ];
};

const compareDefaultOrder = (a: unknown, b: unknown): number => {
    const left = defaultOrderKey(a);
    const right = defaultOrderKey(b);
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
};

/**
 * A copy of `rules` in the 1.x default order: titled rules first, most specific first. Stable.
 */
const sortRulesByDefaultOrder = (rules: readonly unknown[]): unknown[] => [...rules].sort(compareDefaultOrder);

export { sortRulesByDefaultOrder };
