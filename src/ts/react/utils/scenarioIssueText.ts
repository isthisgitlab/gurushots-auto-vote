import { interp } from './interp';

type Translate = (key: string) => string;

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
        return { text: interp(t(key), values), known: true };
    }
    return { text: t('app.scenarioIssueGeneric'), known: false };
};
