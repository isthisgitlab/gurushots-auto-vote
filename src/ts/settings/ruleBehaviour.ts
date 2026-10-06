/**
 * What makes a challenge rule worth keeping, dependency-free so the settings layer
 * and the renderer's rule editor judge it the same way (it imports nothing, so it
 * adds nothing to the renderer bundle).
 */

/**
 * Settings a rule may override INLINE, without going through a named profile.
 * Deliberately a short allowlist rather than "every perChallenge key": these
 * are the ones that decide whether an UN-JOINED candidate is acted on at all,
 * and an un-joined challenge has no cached id for a per-challenge override to
 * key off — so a rule is the only place they can be expressed. Richer setups
 * belong in a named profile, which this composes with (inline wins).
 *
 * `chosenPhotos` / `chosenPhotosOnly` are here for the same reason: the join
 * must know which photo to enter with before the challenge has a cached id.
 * `chosenPhotos` is the one array-valued key (an empty `[]` is an explicit
 * "no chosen photos", distinct from the absent/'' "inherit").
 */
export const TITLE_RULE_INLINE_KEYS = [
    'autoJoin',
    'autoFill',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
    'scenario',
    'chosenPhotos',
    'chosenPhotosOnly',
];

/** The inline overrides a rule sets: the allowlisted keys whose value is not the editor's "inherit" (null, undefined, ''). */
export const ruleInlineEntries = (rule: Record<string, unknown>): Array<[string, unknown]> =>
    TITLE_RULE_INLINE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(rule, key)).flatMap((key) =>
        rule[key] === null || rule[key] === undefined || rule[key] === ''
            ? []
            : [[key, rule[key]] as [string, unknown]],
    );

/**
 * A rule keeps its row only while it still contributes something: a profile, tags,
 * or an inline value. `isValid` judges each inline value (the settings layer passes
 * its schema check); one invalid value voids the inline part, as the sanitizer
 * rejects the whole rule's overrides then. Without it every value counts.
 */
export const ruleHasBehaviour = (
    rule: Record<string, unknown>,
    isValid: (key: string, value: unknown) => boolean = () => true,
): boolean => {
    const hasTags = ['mustIncludeTags', 'shouldIncludeTags'].some(
        (key) => Array.isArray(rule[key]) && rule[key].length > 0,
    );
    const inline = ruleInlineEntries(rule);
    return (
        Boolean(rule.profile) || hasTags || (inline.length > 0 && inline.every(([key, value]) => isValid(key, value)))
    );
};
