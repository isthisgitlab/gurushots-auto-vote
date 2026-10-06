/**
 * What makes a challenge rule worth keeping — the dependency-free check the
 * settings layer and the renderer's rule editor share.
 */

import { ruleHasBehaviour, ruleInlineEntries, TITLE_RULE_INLINE_KEYS } from '../../src/ts/settings/ruleBehaviour';

describe('ruleInlineEntries', () => {
    test('lists the allowlisted inline keys a rule sets, leaving out "inherit" values', () => {
        expect(
            ruleInlineEntries({
                title: 'x',
                autoJoin: true,
                autoFill: '',
                scenario: null,
                chosenPhotos: [],
                chosenPhotosOnly: undefined,
                notInline: 1,
            }),
        ).toEqual([
            ['autoJoin', true],
            ['chosenPhotos', []],
        ]);
    });

    test('an explicit false or 0 is a value, not "inherit"', () => {
        expect(ruleInlineEntries({ autoJoin: false, autoJoinWithinHoursOfEnd: 0 })).toEqual([
            ['autoJoin', false],
            ['autoJoinWithinHoursOfEnd', 0],
        ]);
    });

    test('the allowlist is the one the sanitizer uses', () => {
        expect(TITLE_RULE_INLINE_KEYS).toContain('chosenPhotos');
        expect(TITLE_RULE_INLINE_KEYS).toContain('scenario');
    });
});

describe('ruleHasBehaviour', () => {
    test('a bare match condition does nothing', () => {
        expect(ruleHasBehaviour({ title: 'Hats' })).toBe(false);
        expect(ruleHasBehaviour({ title: 'Hats', mustIncludeTags: [], shouldIncludeTags: [], profile: '' })).toBe(
            false,
        );
    });

    test.each([
        ['a profile', { title: 'Hats', profile: 'Mine' }],
        ['must tags', { title: 'Hats', mustIncludeTags: ['hat'] }],
        ['should tags', { title: 'Hats', shouldIncludeTags: ['hat'] }],
        ['an inline value', { title: 'Hats', chosenPhotosOnly: true }],
    ])('%s is behaviour', (_name, rule) => {
        expect(ruleHasBehaviour(rule)).toBe(true);
    });

    test('an inline value counts only when valid; one invalid value voids the inline part', () => {
        const rule = { title: 'Hats', autoJoin: true, chosenPhotos: ['bad id'] };
        const valid = (key: string, value: unknown) =>
            key !== 'chosenPhotos' || (value as string[]).every((id) => !id.includes(' '));
        expect(ruleHasBehaviour(rule, valid)).toBe(false);
        expect(ruleHasBehaviour({ ...rule, chosenPhotos: ['ok'] }, valid)).toBe(true);
        // Tags and a profile do not depend on the inline values.
        expect(ruleHasBehaviour({ ...rule, profile: 'Mine' }, valid)).toBe(true);
    });
});
