/**
 * The Chosen Photos settings on the facade: validation, the resolution order,
 * challenge rules that hold nothing but a chosen list, the cleanup exception
 * that keeps an un-joined challenge's entry, and the scenario export/preview.
 * Drives the in-memory headless-store seam so the facade round-trips without fs.
 */

import settings = require('../../src/ts/settings');
import { invalid } from '../helpers/invalid';
import logger = require('../../src/ts/logger');
import type * as openChallengesModule from '../../src/ts/settings/openChallenges';
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';
import { isConfig } from '../helpers/storedShapes';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { isRecordOf, isShape, isUnknown, parseJsonAs } from '../helpers/parseJson';
import type { MemoryStore } from '../helpers/headlessStore';
const { forgetOpenChallengeIds, getOpenChallengeIds, getUpcomingChallengeIds } =
    require('../../src/ts/settings/openChallenges') as typeof openChallengesModule;
const { scenarioStateLedger, initialState } =
    require('../../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;

jest.mock('../../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

describe('Chosen Photos settings', () => {
    let store: MemoryStore;
    const blob = () => parseJsonAs(store.value!, isConfig);

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([]);
        forgetOpenChallengeIds();
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    describe('validation', () => {
        test('accepts a list of safe ids, empty included, and the Only flag', () => {
            expect(settings.setGlobalDefault('chosenPhotos', ['abc123', 'photo_pink-1', 'A'.repeat(64)])).toBe(true);
            expect(settings.setGlobalDefault('chosenPhotos', [])).toBe(true);
            expect(settings.setGlobalDefault('chosenPhotosOnly', true)).toBe(true);
            expect(settings.setGlobalDefault('chosenPhotosOnly', 'yes')).toBe(false);
        });

        test.each([
            ['an id with a space', ['a b']],
            ['an id with a path separator', ['../x']],
            ['an empty id', ['']],
            ['an over-long id', ['A'.repeat(65)]],
            ['a duplicate', ['a', 'a']],
            ['a number', [1]],
            [
                'more than the cap',
                Array.from({ length: settings.SETTINGS_SCHEMA.chosenPhotos.default.length + 21 }, (_, i) => `p${i}`),
            ],
            ['a non-list', 'abc'],
        ])('rejects %s', (_name, value) => {
            expect(settings.setGlobalDefault('chosenPhotos', value)).toBe(false);
        });

        test('a rejected list is logged as a count, never as the ids, whether it is a global default or a challenge’s own', () => {
            const category = logger.withCategory('settings');
            const ids = ['private_a', 'private_b', ''];

            expect(settings.setGlobalDefault('chosenPhotos', ids)).toBe(false);
            expect(settings.setChallengeOverride('chosenPhotos', '7', ids)).toBe(false);

            const logged = JSON.stringify(jest.mocked(category.error).mock.calls);
            expect(logged).toContain('3 photo(s)');
            expect(logged).not.toContain('private_');
        });

        test('the cap is small', () => {
            expect(
                settings.setGlobalDefault(
                    'chosenPhotos',
                    Array.from({ length: 20 }, (_, i) => `p${i}`),
                ),
            ).toBe(true);
            expect(
                settings.setGlobalDefault(
                    'chosenPhotos',
                    Array.from({ length: 21 }, (_, i) => `p${i}`),
                ),
            ).toBe(false);
            expect(settings.SETTINGS_SCHEMA.chosenPhotos.type).toBe('photos');
        });
    });

    describe('resolution', () => {
        test('the first layer that sets a value wins, and a per-challenge [] clears a global list', () => {
            settings.setGlobalDefault('chosenPhotos', ['global']);
            expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['global']);
            settings.setTitleRules([{ title: 'Big show', chosenPhotos: ['rule'] }]);
            settings.rememberChallengeTitles([{ id: 7, title: 'Big show' }]);
            expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['rule']);
            settings.setChallengeOverride('chosenPhotos', '7', ['mine']);
            expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['mine']);
            settings.setChallengeOverride('chosenPhotos', '7', []);
            expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual([]);
            expect(settings.getEffectiveSetting('chosenPhotos', '8')).toEqual(['global']);
        });

        test('a scenario phase overrides a rule for fills', () => {
            settings.rememberChallengeTitles([{ id: 7, title: 'Big show' }]);
            settings.setTitleRules([{ title: 'Big show', chosenPhotos: ['rule'] }]);
            expect(
                settings.saveScenario({
                    name: 'Plan',
                    version: 1,
                    start: 'main',
                    phases: { main: { settings: { chosenPhotos: ['phase'], chosenPhotosOnly: true } } },
                }),
            ).toEqual({ ok: true, name: 'Plan' });
            settings.setChallengeOverride('scenario', '7', 'Plan');
            scenarioStateLedger.set(7, initialState('Plan', 'main', 1000));
            expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['phase']);
            expect(settings.getEffectiveSetting('chosenPhotosOnly', '7')).toBe(true);
        });
    });

    describe('challenge rules that hold only a chosen list', () => {
        const rule = { title: 'Big show', chosenPhotos: ['a'] };

        test('the rule is kept, and "" inherits while an explicit [] overrides', () => {
            expect(settings.setTitleRules([rule])).toBe(true);
            expect(settings.getTitleRules()).toEqual([expect.objectContaining({ chosenPhotos: ['a'] })]);
            // '' is the editor's "inherit": the rule then holds nothing and is dropped.
            expect(settings.setTitleRules([{ title: 'Big show', chosenPhotos: '' }])).toBe(true);
            expect(settings.getTitleRules()).toEqual([]);
            // An explicit empty list is a real value and keeps the rule.
            expect(settings.setTitleRules([{ title: 'Big show', chosenPhotos: [] }])).toBe(true);
            expect(settings.getTitleRules()).toEqual([expect.objectContaining({ chosenPhotos: [] })]);
            // A rule with an invalid list is refused as a whole.
            expect(settings.setTitleRules([{ title: 'Big show', chosenPhotos: ['a', 'a'] }])).toBe(false);
            expect(settings.TITLE_RULE_INLINE_KEYS).toEqual(
                expect.arrayContaining(['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder']),
            );
        });

        test('it survives deleting its profile and deleting its scenario', () => {
            settings.saveChallengeProfile('Mine', { exposure: 50 });
            settings.saveScenario({ name: 'Plan', version: 1, start: 'main', phases: { main: {} } });
            expect(settings.setTitleRules([{ ...rule, profile: 'Mine', scenario: 'Plan' }])).toBe(true);
            expect(settings.deleteChallengeProfile('Mine')).toBe(true);
            expect(settings.getTitleRules()).toEqual([expect.objectContaining({ chosenPhotos: ['a'] })]);
            expect(settings.deleteScenario('Plan')).toBe(true);
            const [kept] = settings.getTitleRules();
            expect(kept).toEqual(expect.objectContaining({ chosenPhotos: ['a'] }));
            expect(kept).not.toHaveProperty('scenario');
        });
    });

    // Each challenge's own stored values, by id.
    const perChallenge = () =>
        Object.fromEntries(
            Object.entries(blob().challenges).flatMap(([id, record]) => (record.values ? [[id, record.values]] : [])),
        );

    describe('explicit per-challenge chosen keys', () => {
        test('are stored even when they equal the inherited value; other keys are still dropped', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setGlobalDefault('chosenPhotosOnly', true);
            settings.setGlobalDefault('chosenPhotosInOrder', true);
            settings.setGlobalDefault('exposure', 50);
            expect(settings.setChallengeOverride('chosenPhotos', '7', ['a'])).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosOnly', '7', true)).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosInOrder', '7', true)).toBe(true);
            expect(settings.setChallengeOverride('exposure', '7', 50)).toBe(true);
            expect(perChallenge()['7']).toEqual({
                chosenPhotos: ['a'],
                chosenPhotosOnly: true,
                chosenPhotosInOrder: true,
            });
        });

        test('a joined (active) challenge keeps the normal rule: equal to the inherited value means no override', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setGlobalDefault('chosenPhotosOnly', true);
            settings.setGlobalDefault('chosenPhotosInOrder', true);
            settings.rememberChallengeTitles([{ id: 7, title: 'Pink' }]);
            expect(settings.setChallengeOverride('chosenPhotos', '7', ['a'])).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosOnly', '7', true)).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosInOrder', '7', true)).toBe(true);
            expect(perChallenge()['7']).toBeUndefined();
            expect(settings.setChallengeOverrides('7', { chosenPhotos: ['a'] })).toBe(true);
            expect(settings.replaceChallengeOverrides('7', { chosenPhotos: ['a'] }, false)).toBe(true);
            expect(perChallenge()['7']).toBeUndefined();
            // A value that differs is still stored, and an id that is not active keeps equal ones.
            expect(settings.setChallengeOverride('chosenPhotos', '7', ['b'])).toBe(true);
            expect(perChallenge()['7']).toEqual({ chosenPhotos: ['b'] });
            expect(settings.setChallengeOverride('chosenPhotos', '8', ['a'])).toBe(true);
            expect(perChallenge()['8']).toEqual({ chosenPhotos: ['a'] });
        });

        test('also when a whole container is written, by the batch and the replace path', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setGlobalDefault('exposure', 50);
            expect(settings.setChallengeOverrides('8', { chosenPhotos: ['a'], exposure: 50 })).toBe(true);
            expect(perChallenge()['8']).toEqual({ chosenPhotos: ['a'] });
            expect(settings.replaceChallengeOverrides('9', { chosenPhotos: ['a'], exposure: 50 }, false)).toBe(true);
            expect(perChallenge()['9']).toEqual({ chosenPhotos: ['a'] });
        });

        test('are removed only by an explicit removal, so an un-joined challenge can inherit again', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setChallengeOverride('chosenPhotos', '7', ['a']);
            expect(settings.removeChallengeOverride('chosenPhotos', '7')).toBe(true);
            expect(perChallenge()['7']).toBeUndefined();
        });
    });

    describe('rejected values never put a photo list in the log', () => {
        const errorLog = () => jest.mocked(logger.withCategory('settings').error);
        const errorCalls = () => errorLog().mock.calls;

        beforeEach(() => {
            errorLog().mockClear();
        });

        test.each([
            ['a global default', () => settings.setGlobalDefault('chosenPhotos', ['secret1', 'secret1'])],
            [
                'a per-challenge override',
                () => settings.setChallengeOverride('chosenPhotos', '7', ['secret1', 'secret1']),
            ],
            [
                'a profile',
                () => settings.saveChallengeProfile('Mine', { chosenPhotos: ['secret1', 'secret1'], exposure: 50 }),
            ],
        ])('%s', (_name, write) => {
            expect(write()).toBe(false);
            const printed = JSON.stringify(errorCalls());
            expect(printed).not.toContain('secret1');
            expect(printed).toContain('2 photo(s)');
        });

        test('other values are still logged as written', () => {
            expect(settings.setGlobalDefault('exposure', 'abc')).toBe(false);
            expect(JSON.stringify(errorCalls())).toContain('abc');
        });
    });

    describe('cleanup of stale per-challenge entries', () => {
        const seed = () => {
            settings.setChallengeOverride('chosenPhotos', '100', ['a']);
            settings.setChallengeOverride('chosenPhotosOnly', '101', true);
            settings.setChallengeOverride('exposure', '102', 50);
            settings.setChallengeOverride('chosenPhotos', '103', ['b']);
            settings.setChallengeOverride('chosenPhotos', '104', ['c']);
        };
        const keys = () => Object.keys(blob().challenges).sort();
        // An upcoming challenge as the feed lists it: it starts `startsIn` seconds from now.
        const upcoming = (id: number, startsIn = 3600) => ({
            id,
            start_time: Math.floor(Date.now() / 1000) + startsIn,
        });

        // The main process's own active list: cleanup only prunes what that list also lacks.
        beforeEach(() => {
            settings.rememberChallengeTitles([{ id: '999', title: 'Elsewhere' }]);
        });
        afterAll(() => {
            settings.rememberChallengeTitles([]);
        });

        test('with no active list of its own the main process prunes nothing, whatever it is told', () => {
            seed();
            settings.rememberChallengeTitles([]);
            expect(settings.cleanupStaleChallengeSetting(['999'])).toBe(true);
            expect(keys()).toEqual(['100', '101', '102', '103', '104']);
        });

        test('a challenge the main process knows is active survives a list that omits it', () => {
            seed();
            settings.rememberChallengeTitles([{ id: '102', title: 'Live' }]);
            settings.rememberOpenChallengeIds([100]);
            settings.rememberUpcomingChallenges([]);
            // The caller names only 104: 102 is protected by the main process, 103 is gone for both.
            expect(settings.cleanupStaleChallengeSetting(['104'])).toBe(true);
            expect(keys()).toEqual(['100', '102', '104']);
        });

        test('a challenge only the caller names is kept too: a newer list than the main process has', () => {
            seed();
            settings.rememberOpenChallengeIds([100]);
            settings.rememberUpcomingChallenges([]);
            settings.cleanupStaleChallengeSetting(['102']);
            expect(keys()).toEqual(['100', '102']);
        });

        test('a chosen entry for an open challenge is kept; stale ones of other kinds are pruned', () => {
            seed();
            settings.rememberOpenChallengeIds([100, '101']);
            settings.rememberUpcomingChallenges([]);
            expect(settings.cleanupStaleChallengeSetting(['104'])).toBe(true);
            // 100/101 are open, 104 is active; 102 holds no chosen key, 103 is gone.
            expect(keys()).toEqual(['100', '101', '104']);
        });

        test('an entry holding only the pick-order flag is kept for an open challenge, like the other chosen keys', () => {
            settings.setChallengeOverride('chosenPhotosInOrder', '105', true);
            settings.setChallengeOverride('chosenPhotosInOrder', '106', true);
            settings.rememberOpenChallengeIds([105]);
            settings.rememberUpcomingChallenges([]);
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
            expect(keys()).toEqual(['105']);
            expect(settings.getChallengeOverride('chosenPhotosInOrder', '105')).toBe(true);
        });

        test('with no open list known, chosen entries are kept even with auto-join off, and the join still reads them', () => {
            seed();
            expect(getOpenChallengeIds()).toBeNull();
            expect(settings.getEffectiveSetting('autoJoin', null)).toBe(false);
            settings.cleanupStaleChallengeSetting([]);
            // An entry that holds nothing a join reads is pruned all the same.
            expect(keys()).toEqual(['100', '101', '103', '104']);
            // A manual Join in Discover resolves the per-id list through exactly this read.
            expect(settings.getChallengeOverride('chosenPhotos', '100')).toEqual(['a']);
        });

        test('once the list is known, a chosen entry that is neither open nor active goes', () => {
            seed();
            settings.rememberOpenChallengeIds([100]);
            settings.rememberUpcomingChallenges([]);
            settings.cleanupStaleChallengeSetting([]);
            expect(keys()).toEqual(['100']);
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
        });

        describe('chosen photos saved for an upcoming (not started) challenge', () => {
            // 200 is upcoming: the entry was saved from its Discover row before the challenge started.
            const seedUpcoming = () => {
                settings.setChallengeOverride('chosenPhotos', '200', ['early']);
                settings.setChallengeOverride('chosenPhotosInOrder', '200', true);
                settings.setChallengeOverride('chosenPhotos', '201', ['gone']);
            };
            const early = () => settings.getChallengeOverride('chosenPhotos', '200');

            test('Discover fetch, then a join pass, then cleanup: the list is kept (and a gone one is not)', () => {
                seedUpcoming();
                // Discover: the open list and the whole upcoming list, whatever window it shows.
                settings.rememberOpenChallengeIds([100]);
                settings.rememberUpcomingChallenges([upcoming(200)]);
                // The join pass remembers the open list alone and never touches the upcoming one.
                settings.rememberOpenChallengeIds([100, 101]);
                expect([...(getUpcomingChallengeIds() ?? [])]).toEqual(['200']);
                settings.cleanupStaleChallengeSetting([]);
                expect(early()).toEqual(['early']);
                expect(settings.getChallengeOverride('chosenPhotosInOrder', '200')).toBe(true);
                expect(settings.getChallengeOverride('chosenPhotos', '201')).toBeNull();
            });

            test('lowering the window to 0 changes nothing: the ids of every upcoming challenge are still recorded', () => {
                seedUpcoming();
                settings.rememberOpenChallengeIds([100]);
                // The handler records all of the fetch's ids; the window only decides what is shown.
                settings.rememberUpcomingChallenges([upcoming(200), upcoming(202), upcoming(203)]);
                settings.cleanupStaleChallengeSetting([]);
                expect(early()).toEqual(['early']);
            });

            test('with no upcoming list known (restart, window 0 from launch, first fetch failed) nothing is pruned', () => {
                seedUpcoming();
                // A restart, then a join pass, then cleanup, before any Discover fetch.
                settings.rememberOpenChallengeIds([100]);
                expect(getUpcomingChallengeIds()).toBeNull();
                settings.cleanupStaleChallengeSetting([]);
                expect(early()).toEqual(['early']);
                expect(settings.getChallengeOverride('chosenPhotos', '201')).toEqual(['gone']);
            });

            test('once the challenge has started it is in the open list and the entry stays', () => {
                seedUpcoming();
                settings.rememberUpcomingChallenges([]);
                settings.rememberOpenChallengeIds([200]);
                settings.cleanupStaleChallengeSetting([]);
                expect(early()).toEqual(['early']);
            });

            test('a successful fetch that no longer lists a challenge long past its start lets its entry go', () => {
                seedUpcoming();
                settings.rememberOpenChallengeIds([100]);
                settings.rememberUpcomingChallenges([upcoming(200, -3600)]);
                settings.rememberUpcomingChallenges([]);
                settings.cleanupStaleChallengeSetting([]);
                expect(early()).toBeNull();
            });

            describe('a challenge that has just started: the upcoming feed drops it, the open feed does not list it yet', () => {
                const T0 = 1_800_000_000;
                const at = (seconds: number) => jest.spyOn(Date, 'now').mockReturnValue((T0 + seconds) * 1000);
                afterEach(() => jest.mocked(Date.now).mockRestore?.());

                // 200 starts at T0 + 60; the open list is known and does not hold it.
                const fetchWith200 = () => {
                    at(0);
                    settings.rememberOpenChallengeIds([100]);
                    settings.rememberUpcomingChallenges([{ id: 200, start_time: T0 + 60 }]);
                };
                const feedDropsIt = (seconds: number) => {
                    at(seconds);
                    settings.rememberUpcomingChallenges([]);
                };

                test('its chosen photos survive the cleanup that follows', () => {
                    seedUpcoming();
                    fetchWith200();
                    feedDropsIt(120); // it started a minute ago
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual(['200']);
                    settings.cleanupStaleChallengeSetting([]);
                    expect(early()).toEqual(['early']);
                    // The id that was never in a list is pruned as before.
                    expect(settings.getChallengeOverride('chosenPhotos', '201')).toBeNull();
                });

                test('it is carried across several fetches, keeping its start time', () => {
                    fetchWith200();
                    feedDropsIt(100);
                    feedDropsIt(300);
                    feedDropsIt(659); // the last second inside the 600 s after its start
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual(['200']);
                    feedDropsIt(660);
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual([]);
                });

                test('600 s after its start, still in neither list, its entry is pruned', () => {
                    seedUpcoming();
                    fetchWith200();
                    feedDropsIt(60 + 601);
                    settings.cleanupStaleChallengeSetting([]);
                    expect(early()).toBeNull();
                });

                test('the open list showing it ends the carrying, and the entry is kept by the open list', () => {
                    seedUpcoming();
                    fetchWith200();
                    settings.rememberOpenChallengeIds([100, 200]);
                    feedDropsIt(120);
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual([]);
                    settings.cleanupStaleChallengeSetting([]);
                    expect(early()).toEqual(['early']);
                });

                test('so does the active list (the entry is then protected as active)', () => {
                    fetchWith200();
                    settings.rememberChallengeTitles([
                        { id: '999', title: 'Elsewhere' },
                        { id: '200', title: 'Joined' },
                    ]);
                    feedDropsIt(120);
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual([]);
                });

                test('a start time that is no number counts as the fetch time', () => {
                    at(0);
                    settings.rememberUpcomingChallenges(
                        invalid<Parameters<typeof settings.rememberUpcomingChallenges>[0]>([
                            { id: 200, start_time: 'soon' },
                            { id: null },
                            null,
                        ]),
                    );
                    feedDropsIt(599);
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual(['200']);
                    feedDropsIt(601);
                    expect([...(getUpcomingChallengeIds() ?? [])]).toEqual([]);
                });
            });

            describe('a list fetched by this process long ago says nothing about what other processes saved since', () => {
                const T0 = 1_800_000_000;
                afterEach(() => jest.mocked(Date.now).mockRestore?.());

                test('older than five minutes it is unknown, and cleanup keeps every entry', () => {
                    seedUpcoming();
                    jest.spyOn(Date, 'now').mockReturnValue(T0 * 1000);
                    settings.rememberOpenChallengeIds([100]);
                    settings.rememberUpcomingChallenges([{ id: 200, start_time: T0 + 3600 }]);
                    // Exactly five minutes on it still counts...
                    jest.mocked(Date.now).mockReturnValue((T0 + 300) * 1000);
                    expect(getUpcomingChallengeIds()).not.toBeNull();
                    // ...a moment later it does not: the CLI may have chosen photos for a newly announced id.
                    jest.mocked(Date.now).mockReturnValue((T0 + 300) * 1000 + 1);
                    expect(getUpcomingChallengeIds()).toBeNull();
                    settings.setChallengeOverride('chosenPhotos', '202', ['from-the-cli']);
                    settings.cleanupStaleChallengeSetting([]);
                    expect(early()).toEqual(['early']);
                    expect(settings.getChallengeOverride('chosenPhotos', '202')).toEqual(['from-the-cli']);
                    expect(settings.getChallengeOverride('chosenPhotos', '201')).toEqual(['gone']);
                });

                test('a fresh fetch makes it known again', () => {
                    seedUpcoming();
                    jest.spyOn(Date, 'now').mockReturnValue(T0 * 1000);
                    settings.rememberOpenChallengeIds([100]);
                    settings.rememberUpcomingChallenges([]);
                    jest.mocked(Date.now).mockReturnValue((T0 + 600) * 1000);
                    expect(getUpcomingChallengeIds()).toBeNull();
                    settings.rememberUpcomingChallenges([{ id: 200, start_time: T0 + 3600 }]);
                    settings.cleanupStaleChallengeSetting([]);
                    expect(early()).toEqual(['early']);
                    expect(settings.getChallengeOverride('chosenPhotos', '201')).toBeNull();
                });
            });

            test('logging out forgets both lists', () => {
                settings.rememberOpenChallengeIds([100]);
                settings.rememberUpcomingChallenges([upcoming(200)]);
                forgetOpenChallengeIds();
                expect(getOpenChallengeIds()).toBeNull();
                expect(getUpcomingChallengeIds()).toBeNull();
            });
        });

        test('an empty open list (a failed fetch reads the same) is never remembered, so entries are kept', () => {
            seed();
            settings.rememberOpenChallengeIds([]);
            expect(getOpenChallengeIds()).toBeNull();
            settings.cleanupStaleChallengeSetting([]);
            expect(keys()).toEqual(['100', '101', '103', '104']);
        });

        test('an empty open list leaves the previous list in place', () => {
            seed();
            settings.rememberOpenChallengeIds([100]);
            settings.rememberOpenChallengeIds([]);
            expect([...(getOpenChallengeIds() ?? [])]).toEqual(['100']);
        });

        test('a kept entry keeps its profile mode', () => {
            seed();
            settings.replaceChallengeOverrides('100', { chosenPhotos: ['a'] }, true);
            settings.rememberOpenChallengeIds([100]);
            settings.cleanupStaleChallengeSetting([]);
            expect(blob().challenges['100']).toMatchObject({ suppressRuleProfile: true });
        });
    });

    describe('scenario export and import preview', () => {
        const doc = {
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: {
                main: { settings: { chosenPhotos: ['a'], chosenPhotosOnly: true, exposure: 40, exposureTarget: 50 } },
                late: { settings: { chosenPhotosOnly: false } },
                plain: {},
            },
        };

        const isScenarioDoc = isShape<{ phases: Record<string, { settings: unknown }> }>({
            phases: isRecordOf(isShape<{ settings: unknown }>({ settings: isUnknown })),
        });

        test('export drops the photo ids and says so; everything else stays', () => {
            settings.saveScenario(doc);
            const exported = settings.exportScenarioWithNotes('Plan')!;
            expect(exported.omitted).toEqual(['chosenPhotos']);
            const parsed = parseJsonAs(exported.json, isScenarioDoc);
            expect(parsed.phases.main.settings).toEqual({ chosenPhotosOnly: true, exposure: 40, exposureTarget: 50 });
            expect(parsed.phases.late.settings).toEqual({ chosenPhotosOnly: false });
            expect(settings.exportScenario('Plan')).toBe(exported.json);
            // The stored scenario is untouched.
            expect(settings.getScenario('Plan')!.phases.main.settings).toHaveProperty('chosenPhotos');
        });

        test('a scenario without chosen photos exports as it is, and a missing one is null', () => {
            settings.saveScenario({ name: 'Bare', version: 1, start: 'main', phases: { main: {} } });
            expect(settings.exportScenarioWithNotes('Bare')!.omitted).toEqual([]);
            expect(settings.exportScenarioWithNotes('Nope')).toBeNull();
            expect(settings.exportScenario('Nope')).toBeNull();
        });

        test('the import preview flags both settings by phase', () => {
            const preview = settings.previewScenarioImport(JSON.stringify(doc));
            expect(preview.ok && preview.preview.flagged).toEqual([
                { phase: 'main', key: 'chosenPhotos' },
                { phase: 'main', key: 'chosenPhotosOnly' },
                { phase: 'late', key: 'chosenPhotosOnly' },
            ]);
        });
    });
});
