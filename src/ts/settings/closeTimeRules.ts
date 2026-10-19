/**
 * The rules with a close-time condition (`closesAt` / `closesAtTimes`) in the `settings.json` mirror. A format-1 build
 * ignores that condition and would match such a rule more widely than it means (an auto-join rule would pay for
 * challenges it excluded), so `titleRules` of the mirror leaves them out. They are not lost: the mirror carries them in a
 * top-level key of its own that format-1 builds do not read, and the restore of a missing or damaged configuration takes
 * the key out before the frozen importer sees the text and puts the rules back where they stood.
 *
 * The positions are those of the configuration the mirror was made from. This is for recovery only: if an older build kept
 * the key but changed `titleRules` (added, removed or moved a rule), a restore puts the carried rules back at positions
 * that no longer match, which can shift their precedence among the others. The next mirror write rebuilds the key from
 * the configuration, so the shift lasts until then.
 */

import { isPlainObject } from '../plainObject';

/** The top-level key of the mirror that carries the rules left out of `titleRules`. */
const CLOSE_TIME_RULES_KEY = 'closeTimeRules';

/** A rule left out of `titleRules`, and the position it holds among all the rules (the order is the precedence). */
type CarriedRule = { index: number; rule: Record<string, unknown> };

const hasCloseTimeCondition = (rule: unknown): rule is Record<string, unknown> =>
    isPlainObject(rule) && (rule.closesAt !== undefined || rule.closesAtTimes !== undefined);

/** The rules a format-1 build may read, and the ones carried beside them. */
const splitCloseTimeRules = (rules: readonly unknown[]): { mirrored: unknown[]; carried: CarriedRule[] } => {
    const carried: CarriedRule[] = [];
    const mirrored: unknown[] = [];
    rules.forEach((rule, index) => {
        if (hasCloseTimeCondition(rule)) carried.push({ index, rule });
        else mirrored.push(rule);
    });
    return { mirrored, carried };
};

const isCarriedRule = (value: unknown): value is CarriedRule =>
    isPlainObject(value) && Number.isInteger(value.index) && Number(value.index) >= 0 && isPlainObject(value.rule);

/**
 * The text of a `settings.json` without the carried rules, and the rules it carried (the entries that are not rules are
 * ignored: the file is one the user can edit). A text that does not parse, or carries none, comes back as it is.
 */
const takeCloseTimeRules = (raw: string): { raw: string; carried: CarriedRule[] } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { raw, carried: [] };
    }
    if (!isPlainObject(parsed) || !Object.hasOwn(parsed, CLOSE_TIME_RULES_KEY)) return { raw, carried: [] };
    const { [CLOSE_TIME_RULES_KEY]: sidecar, ...rest } = parsed;
    return { raw: JSON.stringify(rest), carried: Array.isArray(sidecar) ? sidecar.filter(isCarriedRule) : [] };
};

/** `rules` with the carried rules put back at the positions they held (past the end: at the end). */
const attachCloseTimeRules = (rules: readonly unknown[], carried: readonly CarriedRule[]): unknown[] => {
    const all = [...rules];
    for (const { index, rule } of [...carried].sort((a, b) => a.index - b.index)) {
        all.splice(Math.min(index, all.length), 0, rule);
    }
    return all;
};

export { CLOSE_TIME_RULES_KEY, attachCloseTimeRules, splitCloseTimeRules, takeCloseTimeRules };
