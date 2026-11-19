import {
    scenarioIssueText,
    scenarioPathText,
    scenarioRefusalText,
    restrictionText,
    statusReasonText,
} from '@/utils/scenarioIssueText';
import { fillTemplate } from './helpers/setup';

import type { Translate } from '../../src/ts/core/translations/translator';

const keys: Translate = (key) => key;

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
        const t: Translate = (key, vars) =>
            fillTemplate(
                {
                    'app.scenarioIssueTooLarge': 'Larger than {kb} KB',
                    'app.scenarioIssueNoPhase': 'No phase "{name}"',
                    'app.scenarioIssueDuplicateRuleId': 'Id {id}',
                    'app.scenarioIssueConditionDepth': 'Depth {depth}',
                    'app.scenarioIssueMemoryNeverSet': 'Slot {slot}',
                    'app.scenarioIssueNameTooLong': 'Max {max}',
                    'app.scenarioIssueCompareNumber': '{field} is a number',
                    'app.scenarioIssueWindowOnly': 'Only {fields}',
                    'app.scenarioIssueTooManyPhases': 'At most {max}',
                }[key] ?? key,
                vars,
            );
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
        const t: Translate = (key, vars) =>
            fillTemplate(
                { 'app.exposureTarget': 'Exposure Target', 'app.scenarioIssueSetTogether': 'Set {fields} together' }[
                    key
                ] ?? key,
                vars,
            );
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

describe('scenarioPathText', () => {
    const words: Record<string, string> = {
        'app.scenarioPathPhase': 'Phase {name}',
        'app.sbRuleN': 'Rule {n}',
        'app.scenarioPathCondition': 'Condition {n}',
        'app.scenarioPathAction': 'Action {n}',
        'app.scenarioPathSettings': 'Settings',
        'app.scenarioPathLimits': 'Limits',
    };
    const t: Translate = (key, vars) => fillTemplate(words[key] ?? key, vars);

    test.each([
        ['phases.main.rules[0].if[0].window', 'Phase main › Rule 1 › Condition 1 › window'],
        ['phases.buildup.rules[1].do[2].with', 'Phase buildup › Rule 2 › Action 3 › with'],
        ['phases.main.rules[0].if[1].of[0].min', 'Phase main › Rule 1 › Condition 2 › Condition 1 › min'],
        ['phases.main.settings.boostTime', 'Phase main › Settings › boostTime'],
        ['limits.swaps', 'Limits › swaps'],
        ['start', 'start'],
        ['phases.late', 'Phase late'],
        ['', ''],
    ])('%s reads %s', (path, text) => {
        expect(scenarioPathText(path, t)).toBe(text);
    });

    test('a segment with no wording stays as written, and an inherited name is not one', () => {
        expect(scenarioPathText('phases', t)).toBe('phases');
        expect(scenarioPathText('phases[0].x', t)).toBe('phases[0] › x');
        expect(scenarioPathText('mystery[3]', t)).toBe('mystery[3]');
        expect(scenarioPathText('rules.constructor[1].toString', t)).toBe('rules › constructor[1] › toString');
        expect(scenarioPathText('settings[0]', t)).toBe('settings[0]');
        expect(scenarioPathText('rules[1][2]', t)).toBe('rules[1][2]');
        expect(scenarioPathText('phases.main.rules[0][x]', t)).toBe('Phase main › rules[0][x]');
    });

    test('a very long segment reads in one pass, with or without an index', () => {
        const long = '['.repeat(50_000);
        expect(scenarioPathText(`${long}x`, t)).toBe(`${long}x`);
        expect(scenarioPathText(`${long}[3]`, t)).toBe(`${long}[3]`);
        expect(scenarioPathText(`phases.main.rules${long}[0]`, t)).toBe(`Phase main › rules${long}[0]`);
    });
});

describe('refusal reason codes', () => {
    const t: Translate = (key) => key;

    test.each([
        ['busy', 'app.scenarioRefusal_busy'],
        ['stale-generation', 'app.scenarioRefusal_staleGeneration'],
        ['incompatible-scope', 'app.scenarioRefusal_incompatibleScope'],
        ['conflict', 'app.scenarioRefusal_conflict'],
        ['stale', 'app.scenarioRefusal_stale'],
        ['owner-policy', 'app.scenarioRefusal_ownerPolicy'],
        ['revision-unreadable', 'app.scenarioRefusal_revisionUnreadable'],
        ['not-found', 'app.scenarioRefusal_unknownScenario'],
        ['pool-unbound', null],
    ])('%s reads as its own wording or none', (code, key) => {
        const answer = scenarioRefusalText(code, t);
        if (key === null) expect(answer).toBeNull();
        else expect(answer).toBe(key);
    });

    test('a bare code a validator issue carries words itself', () => {
        expect(scenarioIssueText('busy', t)).toEqual({ text: 'app.scenarioRefusal_busy', known: true });
    });
});

describe('catalogue restrictions', () => {
    const t: Translate = (key) => key;

    test.each([
        ['Only the window manager writes window geometry', 'app.sbRestriction_windowBounds'],
        ['A phase cannot change the scenario assignment itself', 'app.sbRestriction_scenario'],
        ['A phase cannot change Manual Only', 'app.sbRestriction_manualPhotosOnly'],
        ['Only the user changes the resume delay for the next launch', 'app.sbRestriction_autovoteStartupDelay'],
        ['Only the user changes sign-in retention', 'app.sbRestriction_stayLoggedIn'],
        ['Only the user switches between real and mock mode', 'app.sbRestriction_mock'],
        ['Only the voting controller starts or stops voting', 'app.sbRestriction_autovoteRunning'],
        ['Only the voting controller records which launch started voting', 'app.sbRestriction_autovoteStartedLaunch'],
        ['Only the user skips an update version', 'app.sbRestriction_skipUpdateVersion'],
        ['Only the user acknowledges a notice', 'app.sbRestriction_noticeAcknowledgedVersion'],
        ['Only the welcome screen marks onboarding as done', 'app.sbRestriction_onboardingCompleted'],
        ['Only the user enables remote access or rotates its key', 'app.sbRestriction_remoteEnabled'],
    ])('%s reads as %s', (restriction, key) => {
        expect(restrictionText(restriction, t)).toBe(key);
    });

    test('a reason with no wording, or none, reads as the plain "no scenario can change it", never as English', () => {
        expect(restrictionText('Something new the backend says', t)).toBe('app.sbUserOnly');
        expect(restrictionText('constructor', t)).toBe('app.sbUserOnly');
        expect(restrictionText(undefined, t)).toBe('app.sbUserOnly');
    });
});

describe('status reasons', () => {
    const t: Translate = (key) => key;

    test.each([
        ['the saved progress of this challenge cannot be read', 'progress'],
        ['the saved progress of the installation scenario cannot be read', 'progress'],
        ['profile-unavailable: Night', 'profileUnavailable'],
        ['there is no profile named "Night"', 'profileMissing'],
        ['the profile "Night" is not valid', 'profileInvalid'],
        ['the profile "Night" sets manualPhotosOnly, which a phase cannot change', 'profileForbidden'],
        ['nothing is published for this phase yet', 'notPublished'],
        ['the published settings of this phase are malformed', 'outdated'],
        ['the published settings are from an earlier visit to a phase', 'outdated'],
        ['the scenario or its profile changed after its settings were published', 'outdated'],
        ['the published settings of this phase have expired', 'outdated'],
        ['the published settings do not match the bindings of this phase', 'outdated'],
        ['evidence-not-loaded', 'notLoaded'],
        ['challenge-not-started', 'notStarted'],
        ['challenge-closed', 'closed'],
        ['insufficient-history', 'history'],
        ['not-applicable', 'notApplicable'],
        ['not-present', 'notPresent'],
        ['clock-unreadable', 'unreadable'],
        ['turbo-time-malformed', 'unreadable'],
        ['settings-unavailable', 'unreadable'],
        ['something-nobody-worded', 'other'],
        ['', 'other'],
    ])('%j reads as %s', (reason, key) => {
        expect(statusReasonText(reason, t)).toBe(`app.scenarioReason_${key}`);
    });

    test('reasons joined by the evidence read one by one, once each, and an absent one by its own reason', () => {
        expect(statusReasonText('clock-unreadable; absent: not-present; rank-unreadable', t)).toBe(
            'app.scenarioReason_unreadable, app.scenarioReason_notPresent',
        );
    });

    test('no reason at all reads as not known', () => {
        expect(statusReasonText(null, t)).toBe('app.scenarioReason_other');
        expect(statusReasonText(undefined, t)).toBe('app.scenarioReason_other');
    });
});
