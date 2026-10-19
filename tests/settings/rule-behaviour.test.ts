/**
 * What makes a challenge rule worth keeping — the dependency-free check the
 * settings layer and the renderer's rule editor share.
 */

import {
    hasPostJoinInlineValue,
    ruleHasBehaviour,
    ruleInlineEntries,
    TITLE_RULE_INLINE_KEYS,
} from '../../src/ts/settings/ruleBehaviour';
import { sanitizeTitleRuleInline } from '../../src/ts/settings/titleRuleSanitize';

describe('ruleInlineEntries', () => {
    test('lists the allowlisted inline keys a rule sets, leaving out "inherit" values', () => {
        expect(
            ruleInlineEntries({
                title: 'x',
                autoJoin: true,
                autoSubmit: '',
                scenario: null,
                chosenPhotos: [],
                chosenPhotosOnly: undefined,
                chosenPhotosInOrder: false,
                notInline: 1,
            }),
        ).toEqual([
            ['autoJoin', true],
            ['chosenPhotos', []],
            ['chosenPhotosInOrder', false],
        ]);
    });

    test('an explicit false or 0 is a value, not "inherit"', () => {
        expect(ruleInlineEntries({ autoJoin: false, autoJoinWithinHoursOfEnd: 0 })).toEqual([
            ['autoJoin', false],
            ['autoJoinWithinHoursOfEnd', 0],
        ]);
    });

    test('the allowlist is the one the sanitizer uses: a valid setting outside it is refused, every key in it is read', () => {
        // `exposure` is a valid per-challenge setting but not an allowlisted inline key.
        expect(TITLE_RULE_INLINE_KEYS).not.toContain('exposure');
        expect(sanitizeTitleRuleInline({ title: 'x', autoJoin: true, exposure: 50 })).toEqual({ autoJoin: true });
        // Each allowlisted key reaches validation: a value no schema accepts voids the rule.
        for (const key of TITLE_RULE_INLINE_KEYS) {
            expect(sanitizeTitleRuleInline({ title: 'x', [key]: { not: 'valid' } })).toBeNull();
        }
        // The same "inherit" values the editor writes are skipped, as ruleInlineEntries skips them.
        expect(
            sanitizeTitleRuleInline({ title: 'x', autoJoin: '', scenario: null, chosenPhotosOnly: undefined }),
        ).toEqual({});
        expect(sanitizeTitleRuleInline(null)).toEqual({});
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
        ['the pick-order flag', { title: 'Hats', chosenPhotosInOrder: true }],
    ])('%s is behaviour', (_name, rule) => {
        expect(ruleHasBehaviour(rule)).toBe(true);
    });

    test('an inline value counts only when valid; one invalid value voids the inline part', () => {
        const rule = { title: 'Hats', autoJoin: true, chosenPhotos: ['bad id'] };
        const valid = (key: string, value: unknown) =>
            key !== 'chosenPhotos' || (Array.isArray(value) && value.every((id) => !String(id).includes(' ')));
        expect(ruleHasBehaviour(rule, valid)).toBe(false);
        expect(ruleHasBehaviour({ ...rule, chosenPhotos: ['ok'] }, valid)).toBe(true);
        // Tags and a profile do not depend on the inline values.
        expect(ruleHasBehaviour({ ...rule, profile: 'Mine' }, valid)).toBe(true);
    });
});

describe('hasPostJoinInlineValue', () => {
    test.each([
        ['auto-submit', { autoSubmit: true }],
        ['a scenario', { scenario: 'Plan' }],
        ['a chosen photos list, even an empty one', { chosenPhotos: [] }],
        ['the chosen-photos-only flag', { chosenPhotosOnly: true }],
        ['the chosen-photos pick-order flag', { chosenPhotosInOrder: true }],
        ['a join-only key beside one that matters', { autoJoin: true, scenario: 'Plan' }],
    ])('%s matters after the join', (_name, inline) => {
        expect(hasPostJoinInlineValue(inline)).toBe(true);
    });

    test.each([
        ['nothing', {}],
        ['auto-join', { autoJoin: true }],
        ['the join timing', { autoJoinWithinHoursOfEnd: 6, autoJoinAfterPercentElapsed: 50 }],
        ['a key that is no rule inline key', { exposure: 70 }],
    ])('%s does not', (_name, inline) => {
        expect(hasPostJoinInlineValue(inline)).toBe(false);
    });
});
