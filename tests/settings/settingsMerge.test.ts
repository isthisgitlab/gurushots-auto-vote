/**
 * rebaseConfigText: a settings change made again on the document another writer saved meanwhile. Only
 * what the change altered against the text it was made from is applied; what the other writer altered is kept. The
 * configuration's own merge reads both sides as a load does first, so a default is no change.
 */

import { rebaseConfigText } from '../../src/ts/core/settings/settingsMerge';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { getDefaultSettings } from '../../src/ts/core/settings/defaults';

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

describe('rebaseConfigText: the lifecycle members of the configuration', () => {
    const config = (members: Record<string, unknown>) => ({ ...getDefaultSettings(), ...members });
    const merged = (base: object, ours: object, theirs: object): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(rebaseConfigText(text(base), text(ours), text(theirs)));
        if (!isPlainObject(parsed)) throw new Error('not an object');
        return parsed;
    };
    const assignment = (generation: number, executor = 'electron', scenario = 'Whole') => ({
        scenario,
        executor,
        generation,
    });

    test('an installation assignment the other writer saved survives a stale copy of it', () => {
        const base = config({ installationScenario: assignment(1) });
        const ours = config({
            installationScenario: assignment(1),
            app: { ...getDefaultSettings().app, theme: 'dark' },
        });
        const theirs = config({ installationScenario: assignment(2, 'cli') });
        const result = merged(base, ours, theirs);
        expect(result.installationScenario).toEqual(assignment(2, 'cli'));
        expect(isPlainObject(result.app) && result.app.theme).toBe('dark');
    });

    test('an assignment this side changed is kept when the other did not touch it, or removed it', () => {
        const base = config({ installationScenario: assignment(1) });
        // The other writer saved something else meanwhile, so the texts differ and the members are merged.
        const elsewhere = config({
            installationScenario: assignment(1),
            app: { ...getDefaultSettings().app, theme: 'dark' },
        });
        expect(
            merged(base, config({ installationScenario: assignment(2, 'web') }), elsewhere).installationScenario,
        ).toEqual(assignment(2, 'web'));
        expect(merged(base, base, config({})).installationScenario).toBeUndefined();
        expect(
            merged(config({}), config({ installationScenario: assignment(1) }), config({})).installationScenario,
        ).toEqual(assignment(1));
    });

    test('two assignments never mix field by field: the later generation stands whole', () => {
        const base = config({ installationScenario: assignment(1) });
        const ours = config({ installationScenario: assignment(2, 'web', 'Mine') });
        const theirs = config({ installationScenario: assignment(3, 'cli', 'Theirs') });
        expect(merged(base, ours, theirs).installationScenario).toEqual(assignment(3, 'cli', 'Theirs'));
        // The same generation on both sides: this side's.
        expect(
            merged(base, ours, config({ installationScenario: assignment(2, 'cli', 'Theirs') })).installationScenario,
        ).toEqual(assignment(2, 'web', 'Mine'));
        // A removed assignment against a newer one: the newer one, which a stale copy cannot erase.
        expect(merged(base, config({}), theirs).installationScenario).toEqual(assignment(3, 'cli', 'Theirs'));
    });

    test('a malformed assignment on either side reads as none, as a load does', () => {
        const bad = config({ installationScenario: { scenario: 'Whole', executor: 'browser', generation: 1 } });
        expect(merged(bad, bad, config({ installationScenario: assignment(2) })).installationScenario).toEqual(
            assignment(2),
        );
    });

    test('the revision of the collection: the one side that changed it, or one past both when both did', () => {
        const base = config({ scenarioDefinitionsRevision: 3 });
        expect(merged(base, config({ scenarioDefinitionsRevision: 4 }), base).scenarioDefinitionsRevision).toBe(4);
        expect(merged(base, base, config({ scenarioDefinitionsRevision: 5 })).scenarioDefinitionsRevision).toBe(5);
        expect(
            merged(base, config({ scenarioDefinitionsRevision: 4 }), config({ scenarioDefinitionsRevision: 6 }))
                .scenarioDefinitionsRevision,
        ).toBe(7);
        // Two edits that both made revision 4 are two changes the other lacks: the same number stays, as it is one write.
        expect(
            merged(base, config({ scenarioDefinitionsRevision: 4 }), config({ scenarioDefinitionsRevision: 4 }))
                .scenarioDefinitionsRevision,
        ).toBe(4);
        // Not a count on one side: this side's.
        expect(
            merged(base, config({ scenarioDefinitionsRevision: 'x' }), config({ scenarioDefinitionsRevision: 6 }))
                .scenarioDefinitionsRevision,
        ).toBe('x');
    });
});

describe('rebaseConfigText: photo pools', () => {
    const inPools = (pools: unknown) => text({ ...getDefaultSettings(), photoPools: pools });
    const poolsOf = (merged: string): unknown => {
        const parsed: unknown = JSON.parse(merged);
        if (!isPlainObject(parsed)) throw new Error('not an object');
        return parsed.photoPools;
    };
    const rebasePools = (base: unknown, ours: unknown, theirs: unknown): unknown =>
        poolsOf(rebaseConfigText(inPools(base), inPools(ours), inPools(theirs)));

    test('a pool both writers added under one name keeps the one stored first, never replaced by the other', () => {
        expect(rebasePools({}, { Beach: ['ours'] }, { Beach: ['theirs'] })).toEqual({ Beach: ['theirs'] });
    });

    test('pools added under different names both survive', () => {
        expect(rebasePools({}, { Mine: ['m'] }, { Theirs: ['t'] })).toEqual({ Mine: ['m'], Theirs: ['t'] });
    });

    test('a pool this side changed or removed is applied, as for any value', () => {
        expect(rebasePools({ A: ['1'], B: ['2'] }, { A: ['9'] }, { A: ['1'], B: ['2'], C: ['3'] })).toEqual({
            A: ['9'],
            C: ['3'],
        });
    });

    test('with no pools at all in the earlier text, what each side added is kept', () => {
        expect(rebasePools(undefined, { Mine: ['m'] }, { Theirs: ['t'] })).toEqual({ Mine: ['m'], Theirs: ['t'] });
    });

    test('a side that holds no pools at all leaves the other side’s as they are', () => {
        expect(rebasePools(undefined, { Mine: ['m'] }, undefined)).toEqual({ Mine: ['m'] });
        expect(rebasePools({ A: ['1'] }, undefined, { A: ['1'], B: ['2'] })).toBeUndefined();
    });
});
