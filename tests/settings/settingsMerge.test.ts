/**
 * rebaseConfigText: a settings change made again on the document another writer saved meanwhile. Only
 * what the change altered against the text it was made from is applied; what the other writer altered is kept. The
 * configuration's own merge reads both sides as a load does first, so a default is no change.
 */

import { rebaseConfigText } from '../../src/ts/settings/settingsMerge';
import { isPlainObject } from '../../src/ts/plainObject';
import { getDefaultSettings } from '../../src/ts/settings/defaults';

const text = (value: unknown) => JSON.stringify(value, null, 2);
// The generic cases run over the `defaults` container, which holds any keys: the rest of the configuration is the defaults.
const inDefaults = (value: unknown) => text({ ...getDefaultSettings(), defaults: value });
const defaultsOf = (merged: string): unknown => {
    const parsed: unknown = JSON.parse(merged);
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed.defaults;
};
const rebaseText = (base: string | null, ours: string, theirs: string | null): string =>
    JSON.stringify(defaultsOf(rebaseConfigText(base, ours, theirs)), null, 2);
const rebase = (base: unknown, ours: unknown, theirs: unknown): unknown =>
    defaultsOf(rebaseConfigText(inDefaults(base), inDefaults(ours), inDefaults(theirs)));

describe('rebaseConfigText: a three-way merge of the documents', () => {
    test('with nothing else saved since, the changed text is returned as it is', () => {
        const ours = '{"a":1,   "b":2}';
        expect(rebaseConfigText('{"a":1}', ours, '{"a":1}')).toBe(ours);
        expect(rebaseConfigText(null, ours, null)).toBe(ours);
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
        const base = { challenges: { 1: { values: { exposure: 50 } } }, rules: [] };
        const ours = { challenges: { 1: { values: { exposure: 70 } } }, rules: [] };
        const theirs = { challenges: { 1: { values: { exposure: 50 } }, 2: { values: { exposure: 80 } } }, rules: [] };
        expect(rebase(base, ours, theirs)).toEqual({
            challenges: { 1: { values: { exposure: 70 } }, 2: { values: { exposure: 80 } } },
            rules: [],
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

    test('with no earlier text or nothing stored, the other side counts as the defaults', () => {
        expect(JSON.parse(rebaseText(null, inDefaults({ a: 1 }), inDefaults({ b: 2 })))).toEqual({ a: 1, b: 2 });
        expect(JSON.parse(rebaseText(inDefaults({ a: 1 }), inDefaults({ a: 1, c: 3 }), null))).toEqual({ c: 3 });
        expect(JSON.parse(rebaseText('', inDefaults({ a: 1 }), inDefaults({ b: 2 })))).toEqual({ a: 1, b: 2 });
    });

    test('is written as persistence writes it', () => {
        expect(rebaseText(inDefaults({ a: 1 }), inDefaults({ a: 2 }), inDefaults({ a: 1, b: 1 }))).toBe(
            text({ a: 2, b: 1 }),
        );
    });

    test('a __proto__ key stays data and never reaches the prototype', () => {
        const poisoned: unknown = JSON.parse('{"__proto__":{"polluted":true},"b":1}');
        const merged = defaultsOf(rebaseConfigText('{}', inDefaults({ a: 1 }), JSON.stringify({ defaults: poisoned })));
        if (!isPlainObject(merged)) throw new Error('not an object');
        expect(Object.hasOwn(merged, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(merged.a).toBe(1);
    });

    test.each([
        ['stored', '{}', '{"a":2}', '{"token":"sekrit"'],
        ['earlier', '{"token":"sekrit"', '{"a":2}', '{}'],
        ['new', '{}', '{"token":"sekrit"', '{"a":1}'],
    ])(
        'an unreadable %s text is reported by its class: the error never quotes the text',
        (_name, base, ours, theirs) => {
            expect(() => rebaseConfigText(base, ours, theirs)).toThrow(/not valid JSON/);
            try {
                rebaseConfigText(base, ours, theirs);
            } catch (error) {
                expect(String(error)).not.toContain('sekrit');
            }
        },
    );

    test.each([
        ['an unreadable stored text', '{}', '{"a":2}', '{broken'],
        ['a stored text that is not an object', '{}', '{"a":2}', '[1]'],
        ['an unreadable earlier text', '{broken', '{"a":2}', '{}'],
    ])('%s is not overwritten: it throws', (_name, base, ours, theirs) => {
        expect(() => rebaseConfigText(base, ours, theirs)).toThrow();
    });

    describe('the configuration: defaults are not changes', () => {
        // What persistence writes: the stored values over the defaults.
        const config = (stored: Record<string, unknown> = {}) => {
            const defaults = getDefaultSettings();
            return text({ ...defaults, ...stored });
        };
        const rebaseConfig = (base: string | null, ours: string, theirs: string | null): Record<string, unknown> => {
            const merged: unknown = JSON.parse(rebaseConfigText(base, ours, theirs));
            if (!isPlainObject(merged)) throw new Error('not an object');
            return merged;
        };
        const appOf = (merged: Record<string, unknown>): Record<string, unknown> => {
            if (!isPlainObject(merged.app)) throw new Error('app missing');
            return merged.app;
        };
        const authOf = (merged: Record<string, unknown>): Record<string, unknown> => {
            if (!isPlainObject(merged.auth)) throw new Error('auth missing');
            return merged.auth;
        };

        test('with nothing else saved since, the changed text is returned as it is', () => {
            const ours = config({ auth: { ...getDefaultSettings().auth, token: 't2' } });
            expect(rebaseConfigText('{}', ours, '{}')).toBe(ours);
        });

        test('a key absent from the earlier text and set by the other writer survives', () => {
            const base = '{"auth":{"token":"t1"}}';
            const ours = config({ auth: { ...getDefaultSettings().auth, token: 't2' } });
            const theirs = '{"auth":{"token":"t1"},"app":{"noticeAcknowledgedVersion":9}}';
            const merged = rebaseConfig(base, ours, theirs);
            expect(appOf(merged).noticeAcknowledgedVersion).toBe(9);
            expect(authOf(merged).token).toBe('t2');
        });

        test('with no earlier text, only what this side changed from the defaults is applied', () => {
            const ours = config({ app: { ...getDefaultSettings().app, language: 'lv' } });
            const theirs = '{"auth":{"token":"theirs-token"},"app":{"noticeAcknowledgedVersion":9}}';
            const merged = rebaseConfig(null, ours, theirs);
            expect(authOf(merged).token).toBe('theirs-token');
            expect(appOf(merged).noticeAcknowledgedVersion).toBe(9);
            expect(appOf(merged).language).toBe('lv');
        });

        test('a nested container the other writer filled in is kept whatever the earlier text lacked', () => {
            const ours = config({ app: { ...getDefaultSettings().app, language: 'lv' } });
            const theirs = JSON.stringify({ defaults: { exposure: 12 } });
            const merged = rebaseConfig('{}', ours, theirs);
            expect(merged.defaults).toEqual({ exposure: 12 });
            expect(appOf(merged).language).toBe('lv');
        });

        test('a stored value the load replaced is not a change this side made', () => {
            const { apiTimeout } = getDefaultSettings().app;
            // The earlier text holds an out-of-range value; the load turned it into the default in `ours`.
            const base = JSON.stringify({ app: { apiTimeout: -5, language: 'en' } });
            const ours = config({ app: { ...getDefaultSettings().app, language: 'lv' } });
            const theirs = JSON.stringify({ app: { apiTimeout: apiTimeout + 10, language: 'en' } });

            const merged = rebaseConfig(base, ours, theirs);

            expect(appOf(merged).apiTimeout).toBe(apiTimeout + 10);
            expect(appOf(merged).language).toBe('lv');
        });

        test('an invalid value the other writer stored is read as the default, as a load reads it', () => {
            const { apiTimeout } = getDefaultSettings().app;
            const base = JSON.stringify({ app: { language: 'en' } });
            const ours = config({ app: { ...getDefaultSettings().app, language: 'lv' } });
            const theirs = JSON.stringify({ app: { apiTimeout: -5, language: 'en' } });

            expect(appOf(rebaseConfig(base, ours, theirs)).apiTimeout).toBe(apiTimeout);
        });

        test('an unreadable stored text is not overwritten: it throws', () => {
            expect(() => rebaseConfigText('{}', config(), '{broken')).toThrow();
        });

        test('a __proto__ key in the app block is dropped by the read of the other side, and never reaches the prototype', () => {
            const merged = rebaseConfig(
                '{}',
                config({ app: { ...getDefaultSettings().app, language: 'lv' } }),
                '{"app":{"__proto__":{"polluted":true},"theme":"dark"}}',
            );
            expect(Object.hasOwn(appOf(merged), '__proto__')).toBe(false);
            expect(Object.getPrototypeOf(appOf(merged))).toBe(Object.prototype);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expect(appOf(merged).theme).toBe('dark');
        });
    });
});
