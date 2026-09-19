/**
 * Category-keyed join-timing rules on the settings facade.
 *
 * A challenge's entry timing really varies with how LONG it runs, and its
 * `type` / `max_photo_submits` are the payload's proxies for that: on the live
 * account 4-photo defaults run 24h, 2-photo ones 48h, 3-photo ones 72h, while a
 * 4-photo exhibition runs 515h. These rules let one row say "every exhibition
 * waits until 90% has elapsed" without naming a title. Covers:
 *   - setCategoryRules/getCategoryRules round-trip + sanitization
 *   - findCategoryRule matching and specificity (type+pics beats either alone)
 *   - getCategoryRuleOverrides re-validating what it reads back
 *
 * Drives the in-memory headless-store seam (same one title-tag-rules.test.js
 * uses) so the facade round-trips without touching fs.
 */

const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
    })),
}));

describe('settings facade — category join-timing rules', () => {
    let store;

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    describe('getCategoryRules / setCategoryRules', () => {
        test('defaults to an empty array', () => {
            expect(settings.getCategoryRules()).toEqual([]);
        });

        test('round-trips a type-keyed rule', () => {
            expect(settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }])).toBe(true);
            expect(settings.getCategoryRules()).toEqual([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
        });

        test('round-trips a pics-keyed rule', () => {
            expect(settings.setCategoryRules([{ pics: 4, autoJoinWithinHoursOfEnd: 18 }])).toBe(true);
            expect(settings.getCategoryRules()).toEqual([{ pics: 4, autoJoinWithinHoursOfEnd: 18 }]);
        });

        test('normalizes the type to trimmed lowercase', () => {
            settings.setCategoryRules([{ type: '  ExHiBiTion  ', autoJoinAfterPercentElapsed: 90 }]);
            expect(settings.getCategoryRules()[0].type).toBe('exhibition');
        });

        test('drops a row carrying no condition at all (the editor’s empty new row)', () => {
            expect(settings.setCategoryRules([{ autoJoinAfterPercentElapsed: 90 }, { type: 'flash' }])).toBe(true);
            expect(settings.getCategoryRules()).toEqual([{ type: 'flash' }]);
        });

        test('never writes an omitted override, so a rule cannot freeze a default', () => {
            settings.setCategoryRules([{ type: 'flash' }]);
            const [rule] = settings.getCategoryRules();
            expect(Object.prototype.hasOwnProperty.call(rule, 'autoJoinAfterPercentElapsed')).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(rule, 'autoJoinWithinHoursOfEnd')).toBe(false);
        });

        test('an empty-string override means inherit, not 0', () => {
            settings.setCategoryRules([{ type: 'flash', autoJoinAfterPercentElapsed: '' }]);
            expect(settings.getCategoryRules()).toEqual([{ type: 'flash' }]);
        });

        test('0 is preserved as the explicit "off" value, distinct from inherit', () => {
            settings.setCategoryRules([{ type: 'flash', autoJoinAfterPercentElapsed: 0 }]);
            expect(settings.getCategoryRules()).toEqual([{ type: 'flash', autoJoinAfterPercentElapsed: 0 }]);
        });

        describe('rejection (nothing is written)', () => {
            const seed = () => settings.setCategoryRules([{ type: 'flash', autoJoinAfterPercentElapsed: 50 }]);

            test('an override the schema refuses rejects the whole save', () => {
                seed();
                expect(settings.setCategoryRules([{ type: 'default', autoJoinAfterPercentElapsed: 150 }])).toBe(false);
                expect(settings.getCategoryRules()).toEqual([{ type: 'flash', autoJoinAfterPercentElapsed: 50 }]);
            });

            test('a photo count outside 1..10 is rejected, never silently widened', () => {
                seed();
                expect(settings.setCategoryRules([{ pics: 0, autoJoinWithinHoursOfEnd: 1 }])).toBe(false);
                expect(settings.setCategoryRules([{ pics: 99, autoJoinWithinHoursOfEnd: 1 }])).toBe(false);
                expect(settings.setCategoryRules([{ pics: 2.5, autoJoinWithinHoursOfEnd: 1 }])).toBe(false);
                expect(settings.getCategoryRules()).toEqual([{ type: 'flash', autoJoinAfterPercentElapsed: 50 }]);
            });

            test('two rows with the same condition are refused (the winner would be invisible)', () => {
                expect(
                    settings.setCategoryRules([
                        { type: 'flash', autoJoinAfterPercentElapsed: 50 },
                        { type: 'FLASH', autoJoinAfterPercentElapsed: 80 },
                    ]),
                ).toBe(false);
            });

            test('a non-array is refused', () => {
                expect(settings.setCategoryRules(null)).toBe(false);
                expect(settings.setCategoryRules('flash')).toBe(false);
            });
        });
    });

    describe('findCategoryRule', () => {
        test('matches on type alone', () => {
            settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
            expect(settings.findCategoryRule({ type: 'exhibition', max_photo_submits: 4 })).toMatchObject({
                type: 'exhibition',
            });
            expect(settings.findCategoryRule({ type: 'flash', max_photo_submits: 1 })).toBeNull();
        });

        test('matches on photo count alone, across types', () => {
            settings.setCategoryRules([{ pics: 4, autoJoinWithinHoursOfEnd: 18 }]);
            expect(settings.findCategoryRule({ type: 'default', max_photo_submits: 4 })).toMatchObject({ pics: 4 });
            expect(settings.findCategoryRule({ type: 'exhibition', max_photo_submits: 4 })).toMatchObject({ pics: 4 });
            expect(settings.findCategoryRule({ type: 'default', max_photo_submits: 2 })).toBeNull();
        });

        test('the type match is case-insensitive on the challenge', () => {
            settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
            expect(settings.findCategoryRule({ type: 'EXHIBITION', max_photo_submits: 4 })).toMatchObject({
                type: 'exhibition',
            });
        });

        test('a rule naming BOTH conditions beats one naming either alone', () => {
            settings.setCategoryRules([
                { type: 'exhibition', autoJoinAfterPercentElapsed: 90 },
                { pics: 4, autoJoinAfterPercentElapsed: 70 },
                { type: 'exhibition', pics: 4, autoJoinAfterPercentElapsed: 95 },
            ]);
            expect(settings.findCategoryRule({ type: 'exhibition', max_photo_submits: 4 })).toMatchObject({
                autoJoinAfterPercentElapsed: 95,
            });
            // The broad rules still cover what the specific one does not.
            expect(settings.findCategoryRule({ type: 'exhibition', max_photo_submits: 2 })).toMatchObject({
                autoJoinAfterPercentElapsed: 90,
            });
            expect(settings.findCategoryRule({ type: 'default', max_photo_submits: 4 })).toMatchObject({
                autoJoinAfterPercentElapsed: 70,
            });
        });

        test('a tie keeps the EARLIEST rule, so the result never depends on ordering luck', () => {
            settings.setCategoryRules([
                { type: 'default', autoJoinAfterPercentElapsed: 60 },
                { pics: 4, autoJoinAfterPercentElapsed: 80 },
            ]);
            expect(settings.findCategoryRule({ type: 'default', max_photo_submits: 4 })).toMatchObject({
                autoJoinAfterPercentElapsed: 60,
            });
        });

        test('a challenge with neither field matches nothing', () => {
            settings.setCategoryRules([{ type: 'flash', autoJoinAfterPercentElapsed: 50 }]);
            expect(settings.findCategoryRule({})).toBeNull();
            expect(settings.findCategoryRule(undefined)).toBeNull();
        });
    });

    describe('getCategoryRuleOverrides', () => {
        test('returns the saved timing overrides for a matching challenge', () => {
            settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
            expect(settings.getCategoryRuleOverrides({ type: 'exhibition', max_photo_submits: 4 })).toEqual({
                autoJoinAfterPercentElapsed: 90,
            });
        });

        test('returns an empty object when nothing matches', () => {
            settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
            expect(settings.getCategoryRuleOverrides({ type: 'flash', max_photo_submits: 1 })).toEqual({});
        });

        test('ignores a value a hand-edited file made invalid, rather than acting on it', () => {
            // Write straight past the setter, the way editing settings.json does
            // (the store holds the raw JSON blob, so go through it as text).
            settings.setCategoryRules([{ type: 'exhibition', autoJoinAfterPercentElapsed: 90 }]);
            const blob = JSON.parse(store.value);
            blob.challengeSettings.categoryRules = [
                { type: 'exhibition', autoJoinAfterPercentElapsed: 500, autoJoinWithinHoursOfEnd: 12 },
            ];
            store.value = JSON.stringify(blob);
            expect(settings.getCategoryRuleOverrides({ type: 'exhibition', max_photo_submits: 4 })).toEqual({
                autoJoinWithinHoursOfEnd: 12,
            });
        });

        test('a rule keyed only on a category it does not carry is inert', () => {
            settings.setCategoryRules([{ pics: 3, autoJoinWithinHoursOfEnd: 54 }]);
            expect(settings.getCategoryRuleOverrides({ type: 'default', max_photo_submits: 4 })).toEqual({});
            expect(settings.getCategoryRuleOverrides({ type: 'default', max_photo_submits: 3 })).toEqual({
                autoJoinWithinHoursOfEnd: 54,
            });
        });
    });
});
