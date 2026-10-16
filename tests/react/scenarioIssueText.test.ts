import { scenarioIssueText } from '@/utils/scenarioIssueText';

const keys = (key: string) => key;

describe('scenarioIssueText', () => {
    test.each([
        ['No scenario JSON was given', 'app.scenarioIssueNoJson'],
        ['The file is larger than 256 KB', 'app.scenarioIssueTooLarge'],
        ['Not valid JSON: Unexpected token }', 'app.scenarioIssueNotJson'],
        ['A phase cannot change the scenario assignment itself', 'app.scenarioIssuePhaseScenario'],
        ['A phase cannot change Manual Only', 'app.scenarioIssuePhaseManualPhotos'],
        ['Not a per-challenge setting', 'app.scenarioIssueNotPerChallenge'],
        ['Set exposureTarget and boostTime together', 'app.scenarioIssueSetTogether'],
        ['These values conflict with the global defaults they combine with', 'app.scenarioIssueConflictDefaults'],
        ['No phase named "end"', 'app.scenarioIssueNoPhase'],
        ['Duplicate rule id "r1"', 'app.scenarioIssueDuplicateRuleId'],
        ['Conditions nest deeper than 4 levels', 'app.scenarioIssueConditionDepth'],
        ['Memory slot "best" is never remembered by any action', 'app.scenarioIssueMemoryNeverSet'],
        ['Remove line breaks and other control characters', 'app.scenarioIssueControlChars'],
        ['Use letters, digits, "-" or "_", starting with a letter (max 32)', 'app.scenarioIssueIdentifier'],
        ['This name is reserved', 'app.scenarioIssueReserved'],
        ['Name is required', 'app.scenarioIssueNameRequired'],
        ['Name is longer than 60 characters', 'app.scenarioIssueNameTooLong'],
        ["Use letters, digits, spaces and . _ - ' ( )", 'app.scenarioIssueNameChars'],
        ['Use a 24-hour time, HH:MM', 'app.scenarioIssueTimeOfDay'],
        ['Use an upper-case state name such as AVAILABLE', 'app.scenarioIssueStateName'],
        ['Set min, max or both', 'app.scenarioIssueSetMinMax'],
        ['min is larger than max', 'app.scenarioIssueMinMax'],
        ['window only applies to rank and votes', 'app.scenarioIssueWindowOnly'],
        ['boosted compares with true or false', 'app.scenarioIssueCompareBool'],
        ['boosted only supports = and !=', 'app.scenarioIssueOpEquals'],
        ['rank compares with a number', 'app.scenarioIssueCompareNumber'],
        ['from and to are the same time', 'app.scenarioIssueSameTime'],
        ['Write the message', 'app.scenarioIssueWriteMessage'],
        ['Use letters, digits, "-" or "_" (max 40)', 'app.scenarioIssueIdChars'],
        ['A rule needs at least one action', 'app.scenarioIssueNeedsAction'],
        ['A scenario needs at least one phase', 'app.scenarioIssuePhaseNeeded'],
        ['A scenario has at most 8 phases', 'app.scenarioIssueTooManyPhases'],
        ['Invalid input: expected string, received undefined', 'app.scenarioIssueMissing'],
        ['Invalid input: expected number, received string', 'app.scenarioIssueWrongType'],
        ['Unrecognized key: "extra"', 'app.scenarioIssueUnknownKey'],
        ['Too big: expected string to have <=3 characters', 'app.scenarioIssueRange'],
        ['Too small: expected array to have >=1 items', 'app.scenarioIssueRange'],
        ['Invalid option: expected one of "x"|"y"', 'app.scenarioIssueInvalidOption'],
        ['Invalid input: expected 1', 'app.scenarioIssueInvalidOption'],
        ['Invalid string: must match pattern /^a$/', 'app.scenarioIssueInvalidFormat'],
    ])('words %j as %s', (message, key) => {
        expect(scenarioIssueText(message, keys)).toEqual({ text: key, known: true });
    });

    test('fills the placeholders from the message', () => {
        const t = (key: string) =>
            ({
                'app.scenarioIssueTooLarge': 'Larger than {kb} KB',
                'app.scenarioIssueNoPhase': 'No phase "{name}"',
                'app.scenarioIssueDuplicateRuleId': 'Id {id}',
                'app.scenarioIssueConditionDepth': 'Depth {depth}',
                'app.scenarioIssueMemoryNeverSet': 'Slot {slot}',
                'app.scenarioIssueNameTooLong': 'Max {max}',
                'app.scenarioIssueCompareNumber': '{field} is a number',
                'app.scenarioIssueWindowOnly': 'Only {fields}',
                'app.scenarioIssueTooManyPhases': 'At most {max}',
            })[key] ?? key;
        expect(scenarioIssueText('The file is larger than 256 KB', t).text).toBe('Larger than 256 KB');
        expect(scenarioIssueText('No phase named "end"', t).text).toBe('No phase "end"');
        expect(scenarioIssueText('Duplicate rule id "r1"', t).text).toBe('Id r1');
        expect(scenarioIssueText('Conditions nest deeper than 4 levels', t).text).toBe('Depth 4');
        expect(scenarioIssueText('Memory slot "best" is never remembered by any action', t).text).toBe('Slot best');
        expect(scenarioIssueText('Name is longer than 60 characters', t).text).toBe('Max 60');
        expect(scenarioIssueText('rank compares with a number', t).text).toBe('rank is a number');
        expect(scenarioIssueText('window only applies to rank and votes', t).text).toBe('Only rank and votes');
        expect(scenarioIssueText('A scenario has at most 8 phases', t).text).toBe('At most 8');
    });

    test('a list of setting keys is shown by the settings translated names, or the key when it has none', () => {
        const t = (key: string) =>
            ({ 'app.exposureTarget': 'Exposure Target', 'app.scenarioIssueSetTogether': 'Set {fields} together' })[
                key
            ] ?? key;
        expect(scenarioIssueText('Set exposureTarget and mysterySetting together', t).text).toBe(
            'Set Exposure Target, mysterySetting together',
        );
    });

    test('a message with no wording is the generic line and is reported as unknown', () => {
        expect(scenarioIssueText('Value must be between 1 and 10', keys)).toEqual({
            text: 'app.scenarioIssueGeneric',
            known: false,
        });
        expect(scenarioIssueText('', keys).known).toBe(false);
    });
});
