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
import type * as clearModule from '../../src/ts/settings/chosenPhotosClear';
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';
import type { AndroidHeadlessStore, AppSettings } from '../../src/ts/types/settings';
const { __resetOpenChallengeIds, getOpenChallengeIds } =
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

const g = globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean; AndroidHeadlessStore?: AndroidHeadlessStore };

describe('Chosen Photos settings', () => {
    let store: AndroidHeadlessStore & {
        value: string | null;
        keys: Record<string, string>;
        readKey: (key: string) => string | null;
        writeKey: (key: string, data: string) => void;
    };
    const blob = () => JSON.parse(store.value!) as AppSettings;

    beforeEach(() => {
        g.__GS_HEADLESS__ = true;
        store = {
            value: null,
            keys: {},
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
            readKey: (key) => store.keys[key] ?? null,
            writeKey: (key, data) => {
                store.keys[key] = data;
            },
        };
        g.AndroidHeadlessStore = store;
        settings.rememberChallengeTitles([]);
        __resetOpenChallengeIds();
    });

    afterEach(() => {
        delete g.__GS_HEADLESS__;
        delete g.AndroidHeadlessStore;
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

        test('the cap is small, and the member record is an internal string', () => {
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
            expect(settings.SETTINGS_SCHEMA.chosenPhotosMemberId.perChallenge).toBe(false);
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
                expect.arrayContaining(['chosenPhotos', 'chosenPhotosOnly']),
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

    describe('explicit per-challenge chosen keys', () => {
        const perChallenge = () => blob().challengeSettings.perChallenge;

        test('are stored even when they equal the inherited value; other keys are still dropped', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setGlobalDefault('chosenPhotosOnly', true);
            settings.setGlobalDefault('exposure', 50);
            expect(settings.setChallengeOverride('chosenPhotos', '7', ['a'])).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosOnly', '7', true)).toBe(true);
            expect(settings.setChallengeOverride('exposure', '7', 50)).toBe(true);
            expect(perChallenge()['7']).toEqual({ chosenPhotos: ['a'], chosenPhotosOnly: true });
        });

        test('a joined (active) challenge keeps the normal rule: equal to the inherited value means no override', () => {
            settings.setGlobalDefault('chosenPhotos', ['a']);
            settings.setGlobalDefault('chosenPhotosOnly', true);
            settings.rememberChallengeTitles([{ id: 7, title: 'Pink' }]);
            expect(settings.setChallengeOverride('chosenPhotos', '7', ['a'])).toBe(true);
            expect(settings.setChallengeOverride('chosenPhotosOnly', '7', true)).toBe(true);
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
        const keys = () => Object.keys(blob().challengeSettings.perChallenge).sort();

        test('a chosen entry for an open challenge is kept; stale ones of other kinds are pruned', () => {
            seed();
            settings.rememberOpenChallengeIds([100, '101']);
            expect(settings.cleanupStaleChallengeSetting(['104'])).toBe(true);
            // 100/101 are open, 104 is active; 102 holds no chosen key, 103 is gone.
            expect(keys()).toEqual(['100', '101', '104']);
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
            settings.cleanupStaleChallengeSetting([]);
            expect(keys()).toEqual(['100']);
            expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
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
            expect(blob().challengeSettings.titleProfileSuppressions).toEqual({ '100': true });
        });
    });

    describe('clearing every list (clearChosenPhotos)', () => {
        const seedEverywhere = () => {
            settings.setGlobalDefault('chosenPhotos', ['g']);
            settings.setGlobalDefault('chosenPhotosOnly', true);
            settings.setChallengeOverride('chosenPhotos', '1', ['c']);
            settings.setChallengeOverride('chosenPhotosOnly', '1', true);
            settings.setChallengeOverride('exposure', '1', 40);
            settings.setChallengeOverride('chosenPhotos', '2', ['d']); // nothing else on this challenge
            settings.setChallengeOverride('chosenPhotos', '3', []); // an explicit empty list
            settings.saveChallengeProfile('Mine', { chosenPhotos: ['p'], chosenPhotosOnly: true, exposure: 50 });
            settings.setTitleRules([
                { title: 'Only list', chosenPhotos: ['r'] },
                { title: 'Keeps tags', chosenPhotos: ['r'], mustIncludeTags: ['Pink'] },
                { title: 'Only flag', chosenPhotosOnly: true },
            ]);
            settings.saveScenario({
                name: 'Plan',
                version: 1,
                start: 'main',
                phases: {
                    main: {
                        settings: { chosenPhotos: ['s'], chosenPhotosOnly: true, exposure: 40, exposureTarget: 50 },
                    },
                    plain: {},
                },
            });
            settings.setSetting('chosenPhotosMemberId', 'member-A');
        };

        test('removes every list in every layer and forgets the owner; the Only flags stay', () => {
            seedEverywhere();
            expect(settings.clearChosenPhotos()).toBe(7);
            const { challengeSettings } = blob();
            expect(challengeSettings.globalDefaults).toEqual(
                expect.not.objectContaining({ chosenPhotos: expect.anything() }),
            );
            expect(challengeSettings.globalDefaults.chosenPhotosOnly).toBe(true);
            // A challenge that held only a list has nothing left; the rest keep what they had.
            expect(challengeSettings.perChallenge).toEqual({ '1': { chosenPhotosOnly: true, exposure: 40 } });
            expect(challengeSettings.profiles?.Mine).toEqual({ chosenPhotosOnly: true, exposure: 50 });
            // A rule keeps its row while it still says something, and goes when the list was all it had.
            expect(challengeSettings.titleRules).toEqual([
                expect.objectContaining({ title: 'Keeps tags', mustIncludeTags: ['Pink'] }),
                expect.objectContaining({ title: 'Only flag', chosenPhotosOnly: true }),
            ]);
            expect(challengeSettings.titleRules.some((rule) => 'chosenPhotos' in rule)).toBe(false);
            expect(settings.getScenario('Plan')!.phases.main.settings).toEqual({
                chosenPhotosOnly: true,
                exposure: 40,
                exposureTarget: 50,
            });
            expect(blob().chosenPhotosMemberId).toBe('');
        });

        test('a hand-edited blob with malformed scenarios, rules and profiles is walked without error', () => {
            seedEverywhere();
            const raw = blob();
            raw.challengeSettings.scenarios = {
                ...raw.challengeSettings.scenarios,
                NotADocument: 'x',
                NoPhases: { phases: 'nope' },
                NullPhase: { phases: { main: null, other: { settings: 'nope' } } },
            };
            raw.challengeSettings.profiles = { ...raw.challengeSettings.profiles, Broken: invalid(null) };
            store.value = JSON.stringify(raw);
            expect(settings.clearChosenPhotos()).toBe(7);
            expect(settings.getScenario('Plan')!.phases.main.settings).not.toHaveProperty('chosenPhotos');
        });

        test('with nothing saved it removes nothing and still clears the owner record', () => {
            settings.setSetting('chosenPhotosMemberId', 'member-A');
            expect(settings.clearChosenPhotos()).toBe(0);
            expect(blob().chosenPhotosMemberId).toBe('');
        });

        test('logs the count of removed lists and never a photo id', () => {
            seedEverywhere();
            const info = jest.mocked(logger.withCategory('settings').info);
            info.mockClear();
            settings.clearChosenPhotos();
            const printed = JSON.stringify(info.mock.calls);
            expect(printed).toContain('Removed 7 chosen-photo list(s)');
            expect(printed).not.toMatch(/"[gcdprs]"/);
        });

        test('is null when the settings cannot be saved', () => {
            jest.isolateModules(() => {
                jest.doMock('../../src/ts/settings/persistence', () => {
                    const actual = jest.requireActual<typeof import('../../src/ts/settings/persistence')>(
                        '../../src/ts/settings/persistence',
                    );
                    return { ...actual, saveSettings: () => false };
                });
                const isolated = require('../../src/ts/settings/chosenPhotosClear') as typeof clearModule;
                expect(isolated.clearChosenPhotos()).toBeNull();
            });
            jest.dontMock('../../src/ts/settings/persistence');
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

        test('export drops the photo ids and says so; everything else stays', () => {
            settings.saveScenario(doc);
            const exported = settings.exportScenarioWithNotes('Plan')!;
            expect(exported.omitted).toEqual(['chosenPhotos']);
            const parsed = JSON.parse(exported.json) as typeof doc;
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
