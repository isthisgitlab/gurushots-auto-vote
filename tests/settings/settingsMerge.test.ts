/**
 * rebaseSettingsText: a settings change made again on the blob another writer saved meanwhile. Only what the change
 * altered against the text it was made from is applied; what the other writer altered is kept.
 */

import { rebaseSettingsText } from '../../src/ts/settings/settingsMerge';
import { isPlainObject } from '../../src/ts/plainObject';
import { getDefaultSettings } from '../../src/ts/settings/defaults';

const text = (value: unknown) => JSON.stringify(value, null, 2);
const rebase = (base: unknown, ours: unknown, theirs: unknown) =>
    JSON.parse(rebaseSettingsText(text(base), text(ours), text(theirs))) as unknown;

describe('rebaseSettingsText', () => {
    test('with nothing else saved since, the changed text is returned as it is', () => {
        const ours = '{"a":1,   "b":2}';
        expect(rebaseSettingsText('{"a":1}', ours, '{"a":1}')).toBe(ours);
        expect(rebaseSettingsText(null, ours, null)).toBe(ours);
    });

    test('a setting each side changed, in different keys, survives', () => {
        expect(rebase({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
    });

    test('a key the other side added is kept, and so is one this side added', () => {
        expect(rebase({ a: 1 }, { a: 1, mine: 1 }, { a: 1, theirs: 2 })).toEqual({ a: 1, mine: 1, theirs: 2 });
    });

    test('a key this side removed is removed; one the other side removed stays removed', () => {
        expect(rebase({ a: 1, b: 2, c: 3 }, { a: 1, c: 3 }, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, c: 3 });
        expect(rebase({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 3 }, { a: 1, c: 3 })).toEqual({ a: 1, c: 3 });
    });

    test('where both sides changed one value, this side wins', () => {
        expect(rebase({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 });
    });

    test('nested objects merge key by key (one challenge override each)', () => {
        const base = { challengeSettings: { perChallenge: { 1: { exposure: 50 } }, titleRules: [] } };
        const ours = { challengeSettings: { perChallenge: { 1: { exposure: 70 } }, titleRules: [] } };
        const theirs = {
            challengeSettings: { perChallenge: { 1: { exposure: 50 }, 2: { exposure: 80 } }, titleRules: [] },
        };
        expect(rebase(base, ours, theirs)).toEqual({
            challengeSettings: { perChallenge: { 1: { exposure: 70 }, 2: { exposure: 80 } }, titleRules: [] },
        });
    });

    test('an object both sides added merges, and an array is replaced whole', () => {
        expect(rebase({}, { x: { a: 1 } }, { x: { b: 2 } })).toEqual({ x: { a: 1, b: 2 } });
        expect(rebase({ list: [1] }, { list: [1, 2] }, { list: [1, 3] })).toEqual({ list: [1, 2] });
        expect(rebase({ list: [1] }, { list: [1] }, { list: [1, 3] })).toEqual({ list: [1, 3] });
        expect(rebase({ list: [1, 2] }, { list: [1, 2] }, { list: [1, 3] })).toEqual({ list: [1, 3] });
    });

    test('equal objects are recognised whatever their key order', () => {
        expect(rebase({ o: { a: 1, b: 2 } }, { o: { b: 2, a: 1 }, k: 1 }, { o: { a: 1, b: 9 } })).toEqual({
            o: { a: 1, b: 9 },
            k: 1,
        });
    });

    test('a value of another type replaces whole', () => {
        expect(rebase({ a: { x: 1 } }, { a: 'text' }, { a: { x: 2 } })).toEqual({ a: 'text' });
        expect(rebase({ a: 1 }, { a: { x: 1 } }, { a: 2 })).toEqual({ a: { x: 1 } });
    });

    test('with no earlier text or nothing stored, the other side counts as empty', () => {
        expect(JSON.parse(rebaseSettingsText(null, '{"a":1}', '{"b":2}'))).toEqual({ a: 1, b: 2 });
        expect(JSON.parse(rebaseSettingsText('{"a":1}', '{"a":1,"c":3}', null))).toEqual({ c: 3 });
        expect(JSON.parse(rebaseSettingsText('', '{"a":1}', '{"b":2}'))).toEqual({ a: 1, b: 2 });
    });

    test('is written as persistence writes it', () => {
        expect(rebaseSettingsText('{"a":1}', '{"a":2}', '{"a":1,"b":1}')).toBe(text({ a: 2, b: 1 }));
    });

    test('a __proto__ key stays data and never reaches the prototype', () => {
        const merged: unknown = JSON.parse(
            rebaseSettingsText('{}', '{"a":1}', '{"__proto__":{"polluted":true},"b":1}'),
        );
        if (!isPlainObject(merged)) throw new Error('not an object');
        expect(Object.hasOwn(merged, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(merged.a).toBe(1);
    });

    test.each([
        ['an unreadable stored text', '{"a":1}', '{"a":2}', '{broken'],
        ['a stored text that is not an object', '{"a":1}', '{"a":2}', '[1]'],
        ['an unreadable earlier text', '{broken', '{"a":2}', '{"a":1}'],
    ])('%s is not overwritten: it throws', (_name, base, ours, theirs) => {
        expect(() => rebaseSettingsText(base, ours, theirs)).toThrow();
    });

    describe('defaults are not changes', () => {
        // What persistence writes: the stored values over the defaults.
        const blob = (stored: Record<string, unknown>) => text({ ...getDefaultSettings(), ...stored });
        const rebaseBlob = (base: string | null, ours: string, theirs: string | null): Record<string, unknown> => {
            const merged: unknown = JSON.parse(rebaseSettingsText(base, ours, theirs));
            if (!isPlainObject(merged)) throw new Error('not an object');
            return merged;
        };

        test('a key absent from the earlier text and set by the other writer survives', () => {
            const base = '{"token":"t1"}';
            const ours = blob({ token: 't2' });
            const theirs = '{"token":"t1","noticeAcknowledgedVersion":"9.9.9"}';
            const merged = rebaseBlob(base, ours, theirs);
            expect(merged.noticeAcknowledgedVersion).toBe('9.9.9');
            expect(merged.token).toBe('t2');
        });

        test('with no earlier text, only what this side changed from the defaults is applied', () => {
            const ours = blob({ language: 'lv' });
            const theirs = '{"token":"theirs-token","noticeAcknowledgedVersion":"9.9.9"}';
            const merged = rebaseBlob(null, ours, theirs);
            expect(merged.token).toBe('theirs-token');
            expect(merged.noticeAcknowledgedVersion).toBe('9.9.9');
            expect(merged.language).toBe('lv');
        });

        test('a nested container the other writer filled in is kept whatever the earlier text lacked', () => {
            const ours = blob({ language: 'lv' });
            const theirs = JSON.stringify({ challengeSettings: { globalDefaults: { exposure: 12 } } });
            const merged = rebaseBlob('{}', ours, theirs);
            const challengeSettings = merged.challengeSettings;
            if (!isPlainObject(challengeSettings) || !isPlainObject(challengeSettings.globalDefaults)) {
                throw new Error('challengeSettings missing');
            }
            expect(challengeSettings.globalDefaults.exposure).toBe(12);
            expect(merged.language).toBe('lv');
        });
    });
});
