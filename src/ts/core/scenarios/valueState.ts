/**
 * The value model every scenario read answers in. A value is known, confirmed absent (the evidence says there is
 * nothing there), or unknown (the evidence failed, was malformed, or was not enough). Absence is not failure: only a
 * presence test turns absence into a known boolean, and any ordinary use of an absent or unknown value stays unknown.
 *
 * Truth composition is Strong Kleene: a known branch can decide the answer, failed evidence alone never does.
 *
 * Pure and dependency-free. scenarios/expressions.ts re-exports it; facts.ts reads through it.
 */

type Known<T> = { state: 'known'; value: T };
export type Absent = { state: 'absent'; reason: 'not-applicable' | 'not-present' };
export type Unknown = { state: 'unknown'; reason: string; dependencies: string[] };

export type ValueState<T> = Known<T> | Absent | Unknown;

export type Truth = ValueState<boolean>;

/** A truth composed of others is known or unknown: absence never survives composition. */
export type Verdict = Known<boolean> | Unknown;

const known = <T>(value: T): Known<T> => ({ state: 'known', value });

const absent = (reason: Absent['reason']): Absent => ({ state: 'absent', reason });

const unknownOf = (reason: string, dependencies: readonly string[]): Unknown => ({
    state: 'unknown',
    reason,
    dependencies: [...dependencies],
});

/**
 * The unknown result of values that are not all known: the distinct reasons of its operands (an absent one reads
 * "absent: <reason>") and the union of their dependencies, in the order they were met.
 */
const pending = (states: readonly ValueState<unknown>[]): Unknown => {
    const reasons = new Set<string>();
    const dependencies = new Set<string>();
    for (const item of states) {
        if (item.state === 'known') continue;
        reasons.add(item.state === 'absent' ? `absent: ${item.reason}` : item.reason);
        if (item.state === 'unknown') for (const dependency of item.dependencies) dependencies.add(dependency);
    }
    return unknownOf([...reasons].join('; '), [...dependencies]);
};

const isKnown = <T>(item: ValueState<T>): item is Known<T> => item.state === 'known';

/**
 * `not`: a known truth flips; unknown stays unknown; absent becomes unknown.
 */
const notTruth = (truth: Truth): Verdict => (isKnown(truth) ? known(!truth.value) : pending([truth]));

/**
 * `all`: any known false decides false; otherwise any unknown or absent operand leaves it unknown; otherwise true. An
 * empty list is true.
 */
const allTruth = (truths: readonly Truth[]): Verdict => {
    if (truths.some((truth) => isKnown(truth) && !truth.value)) return known(false);
    const undecided = truths.filter((truth) => !isKnown(truth));
    return undecided.length ? pending(undecided) : known(true);
};

/**
 * `any`: any known true decides true; otherwise any unknown or absent operand leaves it unknown; otherwise false. An
 * empty list is false.
 */
const anyTruth = (truths: readonly Truth[]): Verdict => {
    if (truths.some((truth) => isKnown(truth) && truth.value)) return known(true);
    const undecided = truths.filter((truth) => !isKnown(truth));
    return undecided.length ? pending(undecided) : known(false);
};

export { known, absent, unknownOf, pending, isKnown, notTruth, allTruth, anyTruth };
