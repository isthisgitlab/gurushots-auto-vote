/**
 * The wording of the references an import left unresolved: every shape of reference, the old text shown as it is, the
 * user's own names passed through the caller's cleaner, and the window's English and Latvian templates in step with the
 * English the CLI prints.
 */

import { describeImportRef, IMPORT_REF_ENGLISH } from '../../src/ts/settings/importRefs';
import { notice as englishNotice } from '../../src/ts/translations/english';
import { notice as latvianNotice } from '../../src/ts/translations/latvian';

import type { ImportRef } from '../../src/ts/types/config';

const describe_ = (ref: string | ImportRef, clean?: (value: string) => string) =>
    describeImportRef(ref, IMPORT_REF_ENGLISH, clean);

describe('describeImportRef', () => {
    test.each([
        [
            { holder: { kind: 'rule', number: 3, title: 'Macro…' }, refers: 'profile', name: 'Night' },
            'Rule 3 (Macro…): the profile "Night" doesn\'t exist',
        ],
        [
            { holder: { kind: 'rule', number: 1 }, refers: 'profile', name: 'Night', invalid: true },
            'Rule 1: the profile "Night" can\'t be used',
        ],
        [
            { holder: { kind: 'rule', number: 2 }, refers: 'scenario', name: 'Plan' },
            'Rule 2: the scenario "Plan" doesn\'t exist',
        ],
        [
            { holder: { kind: 'profile', name: 'Day' }, refers: 'scenario', name: 'Plan', invalid: true },
            'Profile "Day": the scenario "Plan" can\'t be used',
        ],
        [
            { holder: { kind: 'challenge', id: '12', title: 'Sunset' }, refers: 'scenario', name: 'Plan' },
            'Challenge "Sunset" (12): the scenario "Plan" doesn\'t exist',
        ],
        [
            { holder: { kind: 'challenge', id: '12' }, refers: 'scenario', name: 'Plan' },
            'Challenge 12: the scenario "Plan" doesn\'t exist',
        ],
    ] satisfies Array<[ImportRef, string]>)('%j reads as one line', (ref, line) => {
        expect(describe_(ref)).toBe(line);
    });

    test('an entry an earlier build stored as text is shown as it is', () => {
        expect(describe_('rules[2].profile: "Night owl"')).toBe('rules[2].profile: "Night owl"');
    });

    test('every name the user wrote goes through the cleaner, and the entry text too', () => {
        const clean = (value: string) => value.replaceAll('!', '');
        expect(
            describe_({ holder: { kind: 'rule', number: 1, title: 'a!' }, refers: 'profile', name: 'b!' }, clean),
        ).toBe('Rule 1 (a): the profile "b" doesn\'t exist');
        expect(
            describe_({ holder: { kind: 'challenge', id: '1!', title: 't!' }, refers: 'scenario', name: 's!' }, clean),
        ).toBe('Challenge "t" (1): the scenario "s" doesn\'t exist');
        expect(describe_({ holder: { kind: 'challenge', id: '1!' }, refers: 'scenario', name: 's' }, clean)).toBe(
            'Challenge 1: the scenario "s" doesn\'t exist',
        );
        expect(describe_({ holder: { kind: 'profile', name: 'p!' }, refers: 'scenario', name: 's' }, clean)).toBe(
            'Profile "p": the scenario "s" doesn\'t exist',
        );
        expect(describe_('old!', clean)).toBe('old');
    });
});

describe('the templates of the window', () => {
    const keys = Object.keys(IMPORT_REF_ENGLISH) as Array<keyof typeof IMPORT_REF_ENGLISH>;
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    test.each(keys)("%s: the window's English is what the CLI prints", (key) => {
        expect(englishNotice[key]).toBe(IMPORT_REF_ENGLISH[key]);
    });

    test.each(keys)('%s: the Latvian fills the same placeholders as the English', (key) => {
        expect(placeholders(latvianNotice[key])).toEqual(placeholders(englishNotice[key]));
    });
});
