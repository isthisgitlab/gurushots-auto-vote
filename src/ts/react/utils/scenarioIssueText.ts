import type { Translate } from '../../core/translations/translator';

/**
 * One kind of validator message: the pattern it is recognised by, the translation key of its wording and the
 * placeholder each capture group fills. The validator (settings/scenarioSchema) and zod write English for the
 * log; this is how the renderer words the same findings in the UI's language.
 */
type IssueKind = { pattern: RegExp; key: string; params?: string[] };

const KINDS: IssueKind[] = [
    // The parser's
    { pattern: /^No scenario JSON was given$/, key: 'app.scenarioIssueNoJson' },
    { pattern: /^The file is larger than (\d+) KB$/, key: 'app.scenarioIssueTooLarge', params: ['kb'] },
    { pattern: /^Not valid JSON: /, key: 'app.scenarioIssueNotJson' },
    // The semantic checks'
    { pattern: /^A phase cannot change the scenario assignment itself$/, key: 'app.scenarioIssuePhaseScenario' },
    { pattern: /^A phase cannot change Manual Only$/, key: 'app.scenarioIssuePhaseManualPhotos' },
    { pattern: /^Not a per-challenge setting$/, key: 'app.scenarioIssueNotPerChallenge' },
    { pattern: /^Set (.+) together$/, key: 'app.scenarioIssueSetTogether', params: ['fields'] },
    { pattern: /^These values conflict with the global defaults/, key: 'app.scenarioIssueConflictDefaults' },
    { pattern: /^No phase named "(.*)"$/, key: 'app.scenarioIssueNoPhase', params: ['name'] },
    { pattern: /^Duplicate rule id "(.*)"$/, key: 'app.scenarioIssueDuplicateRuleId', params: ['id'] },
    {
        pattern: /^Conditions nest deeper than (\d+) levels$/,
        key: 'app.scenarioIssueConditionDepth',
        params: ['depth'],
    },
    {
        pattern: /^Memory slot "(.*)" is never remembered by any action$/,
        key: 'app.scenarioIssueMemoryNeverSet',
        params: ['slot'],
    },
    // The document shape's
    { pattern: /^Remove line breaks and other control characters$/, key: 'app.scenarioIssueControlChars' },
    { pattern: /^Use letters, digits, "-" or "_", starting with a letter/, key: 'app.scenarioIssueIdentifier' },
    { pattern: /^This name is reserved$/, key: 'app.scenarioIssueReserved' },
    { pattern: /^Name is required$/, key: 'app.scenarioIssueNameRequired' },
    { pattern: /^Name is longer than (\d+) characters$/, key: 'app.scenarioIssueNameTooLong', params: ['max'] },
    { pattern: /^Use letters, digits, spaces and /, key: 'app.scenarioIssueNameChars' },
    { pattern: /^Use a 24-hour time, HH:MM$/, key: 'app.scenarioIssueTimeOfDay' },
    { pattern: /^Use an upper-case state name/, key: 'app.scenarioIssueStateName' },
    { pattern: /^Set min, max or both$/, key: 'app.scenarioIssueSetMinMax' },
    { pattern: /^min is larger than max$/, key: 'app.scenarioIssueMinMax' },
    { pattern: /^window only applies to (.+)$/, key: 'app.scenarioIssueWindowOnly', params: ['fields'] },
    { pattern: /^(\w+) compares with true or false$/, key: 'app.scenarioIssueCompareBool', params: ['field'] },
    { pattern: /^(\w+) only supports = and !=$/, key: 'app.scenarioIssueOpEquals', params: ['field'] },
    { pattern: /^(\w+) compares with a number$/, key: 'app.scenarioIssueCompareNumber', params: ['field'] },
    { pattern: /^from and to are the same time$/, key: 'app.scenarioIssueSameTime' },
    { pattern: /^Write the message$/, key: 'app.scenarioIssueWriteMessage' },
    { pattern: /^Use letters, digits, "-" or "_" \(max/, key: 'app.scenarioIssueIdChars' },
    { pattern: /^A rule needs at least one action$/, key: 'app.scenarioIssueNeedsAction' },
    { pattern: /^A scenario needs at least one phase$/, key: 'app.scenarioIssuePhaseNeeded' },
    { pattern: /^A scenario has at most (\d+) phases$/, key: 'app.scenarioIssueTooManyPhases', params: ['max'] },
    // zod's own
    { pattern: /^Invalid input: expected .+, received undefined$/, key: 'app.scenarioIssueMissing' },
    { pattern: /^Invalid input: expected .+, received /, key: 'app.scenarioIssueWrongType' },
    { pattern: /^Unrecognized key/, key: 'app.scenarioIssueUnknownKey' },
    { pattern: /^Too (?:big|small): /, key: 'app.scenarioIssueRange' },
    { pattern: /^Invalid (?:option|input): expected /, key: 'app.scenarioIssueInvalidOption' },
    { pattern: /^Invalid string: /, key: 'app.scenarioIssueInvalidFormat' },
];

/**
 * A validator message in the UI's language. `known` is false for a message no wording exists for — the text is then
 * the generic "not valid" line and the caller logs the original.
 *
 * @param message - a ScenarioIssue's English message
 * @param t - the translation function
 */
export const scenarioIssueText = (message: string, t: Translate): { text: string; known: boolean } => {
    const refusal = scenarioRefusalText(message, t);
    if (refusal !== null) return { text: refusal, known: true };
    for (const { pattern, key, params = [] } of KINDS) {
        const match = pattern.exec(message);
        if (!match) continue;
        const values = Object.fromEntries(params.map((name, index) => [name, match[index + 1]]));
        // A list of setting keys ("exposureTarget and boostTime") reads in their translated names.
        if (values.fields !== undefined && key === 'app.scenarioIssueSetTogether') {
            values.fields = values.fields
                .split(' and ')
                .map((field) => (t(`app.${field}`) === `app.${field}` ? field : t(`app.${field}`)))
                .join(', ');
        }
        return { text: t(key, values), known: true };
    }
    return { text: t('app.scenarioIssueGeneric'), known: false };
};

/**
 * The reason codes the scenario lifecycle and its handlers refuse writes with, as what happened / why / what next.
 * A failed write shows its code through here (ScenarioError feeds a bare code in as an issue message); callers that
 * hold a code directly call this. Everything each says ends in a next step the user can take.
 */
const REFUSAL_KEYS: Record<string, string> = {
    busy: 'app.scenarioRefusal_busy',
    'locks-unavailable': 'app.scenarioRefusal_busy',
    'unresolved-work': 'app.scenarioRefusal_unresolvedWork',
    'state-unreadable': 'app.scenarioRefusal_stateUnreadable',
    'state-unloaded': 'app.scenarioRefusal_stateUnreadable',
    'stale-generation': 'app.scenarioRefusal_staleGeneration',
    'unresolved-spend': 'app.scenarioRefusal_unresolvedSpend',
    'rule-in-progress': 'app.scenarioRefusal_unresolvedSpend',
    'handoff-pending': 'app.scenarioRefusal_unresolvedSpend',
    'handoff-conflict': 'app.scenarioRefusal_staleGeneration',
    'incompatible-scope': 'app.scenarioRefusal_incompatibleScope',
    'unknown-scenario': 'app.scenarioRefusal_unknownScenario',
    'no-scenario': 'app.scenarioRefusal_unknownScenario',
    'no-installation': 'app.scenarioRefusal_noInstallation',
    'invalid-executor': 'app.scenarioRefusal_invalidExecutor',
    'not-saved': 'app.scenarioRefusal_notSaved',
    invalid: 'app.scenarioRefusal_invalid',
    cap: 'app.scenarioRefusal_cap',
    exists: 'app.scenarioRefusal_poolExists',
    'write-failed': 'app.scenarioRefusal_notSaved',
    'until-in-past': 'app.scenarioRefusal_untilInPast',
    'invalid-assumptions': 'app.scenarioRefusal_invalidAssumptions',
    'subjects-unreadable': 'app.scenarioRefusal_subjectsUnreadable',
    'challenge-not-found': 'app.scenarioRefusal_challengeNotFound',
    'challenge-data-incomplete': 'app.scenarioRefusal_challengeNotFound',
    'scenario-scope-mismatch': 'app.scenarioRefusal_incompatibleScope',
    'simulation-busy': 'app.scenarioRefusal_busy',
    'effect-unresolved': 'app.scenarioRefusal_effectUnresolved',
    conflict: 'app.scenarioRefusal_conflict',
    stale: 'app.scenarioRefusal_stale',
    'owner-policy': 'app.scenarioRefusal_ownerPolicy',
    'revision-unreadable': 'app.scenarioRefusal_revisionUnreadable',
    'not-found': 'app.scenarioRefusal_unknownScenario',
};

/** Whether `code` is a refusal reason the app has wording for (a thrown error's text, or a code nobody worded, is not). */
export const isRefusalCode = (code: string): boolean => Object.hasOwn(REFUSAL_KEYS, code);

/**
 * A refusal reason code in the UI's language, or null when the code is not one the app knows.
 *
 * @param code - the `error` a refused write answered with
 * @param t - the translation function
 */
export const scenarioRefusalText = (code: string, t: Translate): string | null =>
    Object.hasOwn(REFUSAL_KEYS, code) ? t(REFUSAL_KEYS[code]) : null;

/** The status reasons (why a value or a schedule row cannot be told) the backend writes, as the wording of each. */
const STATUS_REASONS: Array<{ pattern: RegExp; key: string }> = [
    { pattern: /^the saved progress of (?:this challenge|the installation scenario) cannot be read$/, key: 'progress' },
    // The overlay's own wording when a profile fails the check it is now held to (the name is not shown).
    { pattern: /^profile-unavailable: /, key: 'profileUnavailable' },
    { pattern: /^there is no profile named /, key: 'profileMissing' },
    { pattern: /^the profile ".*" is not valid$/, key: 'profileInvalid' },
    { pattern: /^the profile ".*" sets /, key: 'profileForbidden' },
    { pattern: /^nothing is published for this phase yet$/, key: 'notPublished' },
    { pattern: /^the published settings /, key: 'outdated' },
    { pattern: /^the scenario or its profile changed after /, key: 'outdated' },
    { pattern: /^evidence-not-loaded$/, key: 'notLoaded' },
    { pattern: /^challenge-not-started$/, key: 'notStarted' },
    { pattern: /^challenge-closed$/, key: 'closed' },
    { pattern: /^insufficient-history$/, key: 'history' },
    { pattern: /^not-applicable$/, key: 'notApplicable' },
    { pattern: /^not-present$/, key: 'notPresent' },
    {
        pattern: /(?:-unreadable|-malformed|-unrecognized|-unusable|-unavailable|-unknown|-incomplete)$/,
        key: 'unreadable',
    },
];

/**
 * Why a value or a schedule row cannot be told, in the UI's language. The backend writes these for the log (a code, or a
 * sentence with a name in it), so none reaches the user as written: the ones the app knows read in plain words, and any
 * other reads as "the reason is not known". Several reasons joined by the evidence ("a; b", "absent: c") read one by one.
 *
 * @param reason - an unknown value's or row's `reason`, or an overlay's (none at all reads as not known)
 * @param t - the translation function
 */
export const statusReasonText = (reason: string | null | undefined, t: Translate): string => {
    const wording = (reason ?? '')
        .split('; ')
        .map((part) => part.replace(/^absent: /, ''))
        .map((part) => STATUS_REASONS.find(({ pattern }) => pattern.test(part))?.key ?? 'other');
    return [...new Set(wording)].map((key) => t(`app.scenarioReason_${key}`)).join(', ');
};

/**
 * The plain wording of each reason the capability catalogue gives for a setting no scenario may change, by the catalogue's
 * own (English) text.
 */
const RESTRICTION_KEYS: Record<string, string> = {
    'Only the window manager writes window geometry': 'app.sbRestriction_windowBounds',
    'A phase cannot change the scenario assignment itself': 'app.sbRestriction_scenario',
    'A phase cannot change Manual Only': 'app.sbRestriction_manualPhotosOnly',
    'Only the user changes the resume delay for the next launch': 'app.sbRestriction_autovoteStartupDelay',
    'Only the user changes sign-in retention': 'app.sbRestriction_stayLoggedIn',
    'Only the user switches between real and mock mode': 'app.sbRestriction_mock',
    'Only the voting controller starts or stops voting': 'app.sbRestriction_autovoteRunning',
    'Only the voting controller records which launch started voting': 'app.sbRestriction_autovoteStartedLaunch',
    'Only the user skips an update version': 'app.sbRestriction_skipUpdateVersion',
    'Only the user acknowledges a notice': 'app.sbRestriction_noticeAcknowledgedVersion',
    'Only the welcome screen marks onboarding as done': 'app.sbRestriction_onboardingCompleted',
    'Only the user enables remote access or rotates its key': 'app.sbRestriction_remoteEnabled',
};

/**
 * A catalogue restriction in the UI's language; a reason the app has no wording for (or none given) reads as the plain
 * "no scenario can change it", never as the backend's English text.
 *
 * @param restriction - the catalogue row's `restriction`
 * @param t - the translation function
 */
export const restrictionText = (restriction: string | undefined, t: Translate): string =>
    t(
        restriction !== undefined && Object.hasOwn(RESTRICTION_KEYS, restriction)
            ? RESTRICTION_KEYS[restriction]
            : 'app.sbUserOnly',
    );

// The path keys that name a numbered item, with the wording of the item.
const NUMBERED_SEGMENTS: Record<string, string> = {
    rules: 'app.sbRuleN',
    if: 'app.scenarioPathCondition',
    of: 'app.scenarioPathCondition',
    do: 'app.scenarioPathAction',
};
// The path keys that name a part of the document by themselves.
const NAMED_SEGMENTS: Record<string, string> = {
    settings: 'app.scenarioPathSettings',
    limits: 'app.scenarioPathLimits',
};

/**
 * A path segment split into its name and a trailing `[n]` index (undefined when it has none). A scan from the last
 * `[`, not a pattern with a lazy name group, so a long segment costs one pass.
 */
const splitIndex = (segment: string): { name: string; index: string | undefined } => {
    const open = segment.lastIndexOf('[');
    const tail = segment.slice(open + 1);
    if (open < 0 || !/^\d+\]$/.test(tail)) return { name: segment, index: undefined };
    return { name: segment.slice(0, open), index: tail.slice(0, -1) };
};

/**
 * A ScenarioIssue's path (`phases.main.rules[0].if[0].window`) in the UI's language
 * ("Phase main › Rule 1 › Condition 1 › window"). A segment with no wording stays as written.
 *
 * @param path - the issue's path; empty for a problem with the file as a whole
 * @param t - the translation function
 */
export const scenarioPathText = (path: string, t: Translate): string => {
    const segments = path.split('.');
    const words: string[] = [];
    for (let at = 0; at < segments.length; at++) {
        const segment = segments[at];
        const { name, index } = splitIndex(segment);
        if (name === 'phases' && index === undefined && at + 1 < segments.length) {
            at++;
            words.push(t('app.scenarioPathPhase', { name: segments[at] }));
        } else if (index !== undefined && Object.hasOwn(NUMBERED_SEGMENTS, name)) {
            words.push(t(NUMBERED_SEGMENTS[name], { n: Number(index) + 1 }));
        } else if (index === undefined && Object.hasOwn(NAMED_SEGMENTS, name)) {
            words.push(t(NAMED_SEGMENTS[name]));
        } else {
            words.push(segment);
        }
    }
    return words.join(' › ');
};
