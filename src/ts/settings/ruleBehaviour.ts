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
 * `chosenPhotos` / `chosenPhotosOnly` / `chosenPhotosInOrder` are here for the
 * same reason: the join must know which photo to enter with, and in what order,
 * before the challenge has a cached id.
 * `chosenPhotos` is the one array-valued key (an empty `[]` is an explicit
 * "no chosen photos", distinct from the absent/'' "inherit").
 */
export const TITLE_RULE_INLINE_KEYS = [
    'autoJoin',
    'autoSubmit',
    'autoJoinAfterHoursFromStart',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
    'scenario',
    'chosenPhotos',
    'chosenPhotosOnly',
    'chosenPhotosInOrder',
    'manualPhotosOnly',
];

/**
 * Keys that exist only as "on": `false` is stored nowhere but a challenge's own override. Rules
 * resolve first-match-wins per key, so an explicit `false` in an early broad rule or in a profile
 * would silently cancel a later, more specific "on". The rule sanitizer and the profile sanitizer
 * drop it, and the rule editor offers only inherit / on.
 */
export const ON_ONLY_KEYS: readonly string[] = ['manualPhotosOnly'];

/** Whether a value is the `false` an on-only key may not hold in a rule or profile. */
export const isDroppedOffValue = (key: string, value: unknown): boolean =>
    value === false && ON_ONLY_KEYS.includes(key);

/**
 * The inline keys that only decide whether, and when, an un-joined challenge is joined. Once it is
 * joined they change nothing, so a challenge they alone customize is not marked as customized.
 */
const JOIN_ONLY_INLINE_KEYS = [
    'autoJoin',
    'autoJoinAfterHoursFromStart',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
];

/** Whether inline rule values include any that still matter after the join (auto-submit, scenario, chosen photos). */
export const hasPostJoinInlineValue = (inline: Record<string, unknown>): boolean =>
    Object.keys(inline).some((key) => TITLE_RULE_INLINE_KEYS.includes(key) && !JOIN_ONLY_INLINE_KEYS.includes(key));

/**
 * The inline overrides a rule sets: the allowlisted keys whose value is not the editor's "inherit"
 * (null, undefined, '') and not the `false` of an on-only key.
 */
export const ruleInlineEntries = (rule: Record<string, unknown>): Array<[string, unknown]> =>
    TITLE_RULE_INLINE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(rule, key)).flatMap((key) =>
        rule[key] === null || rule[key] === undefined || rule[key] === '' || isDroppedOffValue(key, rule[key])
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
