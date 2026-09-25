/**
 * Stored scenarios on the settings facade: save / list / rename / delete,
 * JSON import (with the preview step) and export. Drives the in-memory
 * headless-store seam so loadSettings/saveSettings round-trip without fs.
 */

const settings = require('../../src/js/settings');
const logger = require('../../src/js/logger');
const { SCENARIO_TEMPLATES } = require('../../src/js/scenarios/templates');

jest.mock('../../src/js/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

const template = (id) => structuredClone(SCENARIO_TEMPLATES.find((t) => t.id === id).scenario);
const simple = (name = 'Plan') => ({
    name,
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ id: 'fill', do: [{ type: 'fillExposure' }] }] } },
});

describe('settings facade — scenarios', () => {
    let store;

    const storedMap = () => JSON.parse(store.value).challengeSettings.scenarios;

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

    test('defaults to none', () => {
        expect(settings.getScenarios()).toEqual({});
        expect(settings.getScenario('Plan')).toBeNull();
        expect(settings.getScenario('')).toBeNull();
    });

    test('saves, lists and looks up case-insensitively', () => {
        expect(settings.saveScenario(template('eveningBoost'))).toEqual({
            ok: true,
            name: 'Evening boost before the last day',
        });
        expect(Object.keys(settings.getScenarios())).toEqual(['Evening boost before the last day']);
        expect(settings.getScenario('EVENING boost before the last day').start).toBe('main');
    });

    test('an invalid document is refused with its issues', () => {
        const result = settings.saveScenario({ ...simple(), start: 'missing' });
        expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: 'start' })] });
    });

    test('overwriting replaces the old casing; overwrite:false refuses', () => {
        settings.saveScenario(simple('Plan'));
        expect(settings.saveScenario(simple('PLAN')).ok).toBe(true);
        expect(Object.keys(storedMap())).toEqual(['PLAN']);
        expect(settings.saveScenario(simple('plan'), { overwrite: false }).issues[0].message).toContain(
            'already exists',
        );
    });

    test('enforces the scenario cap for new names only', () => {
        for (let i = 0; i < settings.MAX_SCENARIOS; i++) settings.saveScenario(simple(`Plan ${i}`));
        expect(settings.saveScenario(simple('One more')).issues[0].message).toContain('delete one first');
        expect(settings.saveScenario(simple('Plan 0')).ok).toBe(true);
    });

    test('a stored document that no longer validates is skipped and logged', () => {
        settings.saveScenario(simple('Good'));
        const blob = JSON.parse(store.value);
        blob.challengeSettings.scenarios.Broken = { name: 'Broken', version: 99 };
        store.value = JSON.stringify(blob);
        expect(Object.keys(settings.getScenarios())).toEqual(['Good']);
        expect(logger.withCategory().warning).toHaveBeenCalledWith(
            expect.stringContaining('"Broken" is invalid'),
            expect.any(Array),
        );
    });

    test('the read-side validation cache stays bounded', () => {
        for (let i = 0; i < 210; i++) {
            settings.saveScenario({ ...simple(`Plan ${i % 10}`), description: `revision ${i}` });
            expect(Object.keys(settings.getScenarios())).toHaveLength(Math.min(i + 1, 10));
        }
    });

    test('a corrupted (non-object) scenarios map reads as empty', () => {
        settings.saveScenario(simple());
        const blob = JSON.parse(store.value);
        blob.challengeSettings.scenarios = ['not', 'a', 'map'];
        store.value = JSON.stringify(blob);
        expect(settings.getScenarios()).toEqual({});
    });

    describe('renameScenario', () => {
        test('moves the scenario to the new name', () => {
            settings.saveScenario(simple('Old'));
            expect(settings.renameScenario('old', 'New')).toEqual({ ok: true, name: 'New' });
            expect(Object.keys(storedMap())).toEqual(['New']);
        });

        test('a casing-only rename is allowed', () => {
            settings.saveScenario(simple('plan'));
            expect(settings.renameScenario('plan', 'Plan').ok).toBe(true);
            expect(Object.keys(storedMap())).toEqual(['Plan']);
        });

        test('refuses a taken name, an invalid name and a missing scenario', () => {
            settings.saveScenario(simple('A'));
            settings.saveScenario(simple('B'));
            expect(settings.renameScenario('A', 'b').issues[0].message).toContain('already exists');
            expect(settings.renameScenario('A', '').issues[0].path).toBe('name');
            expect(settings.renameScenario('Nope', 'C').issues[0].message).toContain('No scenario named');
            expect(settings.renameScenario('a\nforged', 'C').issues[0].message).toBe('No scenario named "a forged"');
            expect(Object.keys(storedMap()).sort()).toEqual(['A', 'B']);
        });
    });

    test('deleteScenario removes by name; false when absent', () => {
        settings.saveScenario(simple('Plan'));
        expect(settings.deleteScenario('PLAN')).toBe(true);
        expect(settings.getScenarios()).toEqual({});
        expect(settings.deleteScenario('Plan')).toBe(false);
    });

    describe('import / export', () => {
        const json = (doc) => JSON.stringify(doc);

        test('preview describes phases, spending actions and limits without saving', () => {
            const result = settings.previewScenarioImport(json(template('exhibitionDoubleDip')));
            expect(result.ok).toBe(true);
            expect(result.exists).toBe(false);
            expect(result.preview.phases.map((p) => p.name)).toEqual([
                'buildup',
                'holding',
                'pulse',
                'pulseWait',
                'done',
            ]);
            expect(result.preview.phases[0]).toEqual({
                name: 'buildup',
                settings: ['exposure', 'exposureTarget', 'autoFill', 'autoBoost'],
                rules: 3,
            });
            expect(result.preview.spending).toEqual(
                expect.arrayContaining([
                    { phase: 'buildup', rule: 'A photo broke out: hold it back', action: 'swap' },
                    {
                        phase: 'holding',
                        rule: 'Last morning: swap the held photo back in and boost it',
                        action: 'boost',
                    },
                ]),
            );
            expect(result.preview.limits).toEqual({});
            expect(settings.getScenarios()).toEqual({});
        });

        test('preview falls back to the rule id and reports an existing name', () => {
            settings.saveScenario(template('morningSwap'));
            const result = settings.previewScenarioImport(json(template('morningSwap')));
            expect(result.exists).toBe(true);
            expect(result.preview).toEqual(
                expect.objectContaining({
                    limits: { swaps: 10 },
                    spending: [{ phase: 'main', rule: 'morning-swap', action: 'swap' }],
                }),
            );
        });

        test('preview of a document without a description', () => {
            expect(settings.previewScenarioImport(json(simple())).preview.description).toBe('');
        });

        test('preview refuses bad JSON and invalid documents', () => {
            expect(settings.previewScenarioImport('{').issues[0].message).toContain('Not valid JSON');
            expect(settings.previewScenarioImport(json({ ...simple(), version: 2 })).issues[0].path).toBe('version');
        });

        test('import stores; a name clash needs overwrite', () => {
            expect(settings.importScenario(json(simple()))).toEqual({ ok: true, name: 'Plan' });
            expect(settings.importScenario(json(simple()))).toEqual({
                ok: false,
                issues: [expect.objectContaining({ path: 'name' })],
            });
            expect(settings.importScenario(json(simple()), { overwrite: true }).ok).toBe(true);
            expect(settings.importScenario('').ok).toBe(false);
        });

        test('export round-trips through import', () => {
            settings.saveScenario(template('topTenTurbo'));
            const text = settings.exportScenario('turbo in the top 10');
            expect(text.endsWith('\n')).toBe(true);
            settings.deleteScenario('Turbo in the top 10');
            expect(settings.importScenario(text).ok).toBe(true);
            expect(settings.getScenario('Turbo in the top 10')).toEqual(JSON.parse(text));
            expect(settings.exportScenario('missing')).toBeNull();
        });
    });
});

describe('settings facade — scenario assignment', () => {
    let store;
    const blob = () => JSON.parse(store.value).challengeSettings;

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
        settings.rememberChallengeTitles([
            { id: 7, title: 'Big show', type: 'exhibition' },
            { id: 8, title: 'Other' },
        ]);
        settings.saveScenario(simple('Plan'));
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
        settings.rememberChallengeTitles([]);
    });

    test('no scenario by default, and none as a global value', () => {
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('');
        expect(settings.SETTINGS_SCHEMA.scenario.challengeOnly).toBe(true);
    });

    test('assigned per challenge, by a challenge rule, or through a profile', () => {
        expect(settings.setChallengeOverride('scenario', '8', 'Plan')).toBe(true);
        expect(settings.getEffectiveSetting('scenario', '8')).toBe('Plan');
        expect(settings.setTitleRules([{ type: 'exhibition', scenario: 'Plan' }])).toBe(true);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
        expect(settings.saveChallengeProfile('Show tactic', { scenario: 'Plan' })).toBe(true);
    });

    test('a rule may carry a scenario as its only behaviour', () => {
        expect(settings.TITLE_RULE_INLINE_KEYS).toContain('scenario');
        expect(settings.setTitleRules([{ type: 'exhibition', scenario: 'Plan' }])).toBe(true);
        expect(settings.getTitleRules()).toEqual([expect.objectContaining({ scenario: 'Plan' })]);
    });

    const assignEverywhere = () => {
        settings.setChallengeOverride('scenario', '8', 'plan');
        settings.saveChallengeProfile('Show tactic', { scenario: 'Plan', autoFill: true });
        settings.setTitleRules([
            { type: 'exhibition', scenario: 'Plan' },
            { title: 'Other', scenario: 'PLAN', autoFill: true },
            { title: 'Unrelated', scenario: 'Something else' },
        ]);
    };

    test('a rename moves every assignment to the new name', () => {
        assignEverywhere();
        expect(settings.renameScenario('Plan', 'Show plan').ok).toBe(true);
        const stored = blob();
        expect(stored.perChallenge['8'].scenario).toBe('Show plan');
        expect(stored.profiles['Show tactic'].scenario).toBe('Show plan');
        expect(stored.titleRules.map((r) => r.scenario)).toEqual(['Show plan', 'Show plan', 'Something else']);
    });

    test('a delete clears every assignment and drops rules left with nothing to do', () => {
        assignEverywhere();
        expect(settings.deleteScenario('Plan')).toBe(true);
        const stored = blob();
        expect(stored.perChallenge['8'].scenario).toBeUndefined();
        expect(stored.profiles['Show tactic']).toEqual({ autoFill: true });
        expect(stored.titleRules).toEqual([
            expect.objectContaining({ title: 'Other', autoFill: true }),
            expect.objectContaining({ title: 'Unrelated', scenario: 'Something else' }),
        ]);
        expect(stored.titleRules[0].scenario).toBeUndefined();
    });

    test('a delete keeps a rule that still has a profile or tags', () => {
        settings.saveChallengeProfile('Show tactic', { autoFill: true });
        settings.setTitleRules([
            { type: 'exhibition', scenario: 'Plan', profile: 'Show tactic' },
            { title: 'Other', scenario: 'Plan', mustIncludeTags: ['sea'] },
        ]);
        settings.deleteScenario('Plan');
        expect(blob().titleRules).toHaveLength(2);
    });

    test('a delete copes with missing or corrupted assignment containers', () => {
        const raw = JSON.parse(store.value);
        raw.challengeSettings.profiles = { Broken: null };
        raw.challengeSettings.titleRules = 'not a list';
        store.value = JSON.stringify(raw);
        expect(settings.deleteScenario('Plan')).toBe(true);
    });
});

describe('settings facade — scenarios when the save fails', () => {
    let scenarios;

    beforeEach(() => {
        jest.isolateModules(() => {
            jest.doMock('../../src/js/settings/persistence', () => {
                const actual = jest.requireActual('../../src/js/settings/persistence');
                return { ...actual, loadSettings: () => actual.loadSettings(), saveSettings: () => false };
            });
            scenarios = require('../../src/js/settings/scenarios');
        });
    });

    afterEach(() => jest.dontMock('../../src/js/settings/persistence'));

    test('save and delete report the failure', () => {
        expect(scenarios.saveScenario(simple()).issues[0].message).toContain('could not be saved');
    });

    test('delete tolerates a non-list rules container', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/js/settings/persistence', () => {
                const actual = jest.requireActual('../../src/js/settings/persistence');
                const blob = actual.loadSettings();
                blob.challengeSettings.scenarios = { Plan: simple() };
                blob.challengeSettings.titleRules = 'not a list';
                return { ...actual, loadSettings: () => structuredClone(blob), saveSettings: () => true };
            });
            const isolated = require('../../src/js/settings/scenarios');
            expect(isolated.deleteScenario('Plan')).toBe(true);
        });
    });

    test('delete reports false when the save fails', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/js/settings/persistence', () => {
                const actual = jest.requireActual('../../src/js/settings/persistence');
                const blob = actual.loadSettings();
                blob.challengeSettings.scenarios = { Plan: simple() };
                return { ...actual, loadSettings: () => structuredClone(blob), saveSettings: () => false };
            });
            const isolated = require('../../src/js/settings/scenarios');
            expect(isolated.deleteScenario('Plan')).toBe(false);
        });
    });
});
