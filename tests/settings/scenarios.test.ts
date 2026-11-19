/**
 * Stored scenarios on the settings facade: save / list / rename / delete,
 * JSON import (with the preview step) and export. Drives the in-memory
 * headless-store seam so loadSettings/saveSettings round-trip without fs.
 */

import settings = require('../../src/ts/core/settings');
import loggerModule = require('../../src/ts/core/logger');
const logger = jest.mocked(loggerModule);
import type * as templatesModule from '../../src/ts/core/scenarios/templates';
import type * as scenariosModule from '../../src/ts/core/settings/scenarios';
const { SCENARIO_TEMPLATES } = require('../../src/ts/core/scenarios/templates') as typeof templatesModule;
import { invalid } from '../helpers/invalid';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import { isConfig } from '../helpers/storedShapes';
import { parseJsonAs } from '../helpers/parseJson';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';

type SaveRefused = Extract<ReturnType<typeof settings.saveScenario>, { ok: false }>;
type PreviewAccepted = Extract<ReturnType<typeof settings.previewScenarioImport>, { ok: true }>;
type PreviewRefused = Extract<ReturnType<typeof settings.previewScenarioImport>, { ok: false }>;

jest.mock('../../src/ts/core/logger', () => {
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

const template = (id: string) => structuredClone(SCENARIO_TEMPLATES.find((t) => t.id === id)!.scenario);
const simple = (name = 'Plan') => ({
    name,
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ id: 'fill', do: [{ type: 'fillExposure' }] }] } },
});

describe('settings facade — scenarios', () => {
    let store: MemoryStore;

    const storedMap = () => parseJsonAs(store.value!, isConfig).scenarios;

    beforeEach(() => {
        store = installHeadlessStore();
    });

    afterEach(() => {
        removeHeadlessStore();
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
        expect(settings.getScenario('EVENING boost before the last day')!.start).toBe('main');
    });

    test('every template passes checkScenario, the check the builder and check-scenario run', () => {
        for (const { id, scenario } of SCENARIO_TEMPLATES) {
            expect({ id, result: settings.checkScenario(structuredClone(scenario)).ok }).toEqual({ id, result: true });
        }
    });

    test('checkScenario validates without storing', () => {
        expect(settings.checkScenario(simple())).toEqual(expect.objectContaining({ ok: true }));
        expect(settings.checkScenario({ ...simple(), start: 'x' }).ok).toBe(false);
        expect(settings.getScenarios()).toEqual({});
    });

    test('an invalid document is refused with its issues', () => {
        const result = settings.saveScenario({ ...simple(), start: 'missing' });
        expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: 'start' })] });
    });

    const revision = () => settings.getScenarioLibrary().revision as number;

    test('overwriting replaces the old casing; overwrite:false refuses', () => {
        settings.saveScenario(simple('Plan'));
        expect(settings.saveScenario(simple('PLAN'), { expectedDefinitionRevision: revision() }).ok).toBe(true);
        expect(Object.keys(storedMap())).toEqual(['PLAN']);
        expect(
            (settings.saveScenario(simple('plan'), { overwrite: false }) as SaveRefused).issues[0].message,
        ).toContain('already exists');
    });

    test('enforces the scenario cap for new names only', () => {
        for (let i = 0; i < settings.MAX_SCENARIOS; i++) settings.saveScenario(simple(`Plan ${i}`));
        expect((settings.saveScenario(simple('One more')) as SaveRefused).issues[0].message).toContain(
            'delete one first',
        );
        expect(settings.saveScenario(simple('Plan 0'), { expectedDefinitionRevision: revision() }).ok).toBe(true);
    });

    test('a stored document that no longer validates is skipped and logged', () => {
        settings.saveScenario(simple('Good'));
        const blob = parseJsonAs(store.value!, isConfig);
        blob.scenarios.Broken = { name: 'Broken', version: 99 };
        store.value = JSON.stringify(blob);
        expect(Object.keys(settings.getScenarios())).toEqual(['Good']);
        expect(
            invalid<{ withCategory: () => ReturnType<typeof logger.withCategory> }>(logger).withCategory().warning,
        ).toHaveBeenCalledWith(expect.stringContaining('"Broken" is invalid'), expect.any(Array));
    });

    test('the read-side validation cache stays bounded', () => {
        for (let i = 0; i < 210; i++) {
            // An overwrite names the revision it was read at, so each save lands and the next read validates a new document.
            const saved = settings.saveScenario(
                { ...simple(`Plan ${i % 10}`), description: `revision ${i}` },
                { expectedDefinitionRevision: revision() },
            );
            expect(saved.ok).toBe(true);
            expect(Object.keys(settings.getScenarios())).toHaveLength(Math.min(i + 1, 10));
        }
    });

    test('a corrupted (non-object) scenarios map reads as empty', () => {
        settings.saveScenario(simple());
        const blob = parseJsonAs(store.value!, isConfig);
        blob.scenarios = invalid(['not', 'a', 'map']);
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
            expect((settings.renameScenario('A', 'b') as SaveRefused).issues[0].message).toContain('already exists');
            expect((settings.renameScenario('A', '') as SaveRefused).issues[0].path).toBe('name');
            expect((settings.renameScenario('Nope', 'C') as SaveRefused).issues[0].message).toContain(
                'No scenario named',
            );
            expect((settings.renameScenario('a\nforged', 'C') as SaveRefused).issues[0].message).toBe(
                'No scenario named "a forged"',
            );
            expect(Object.keys(storedMap()).sort()).toEqual(['A', 'B']);
        });
    });

    test('deleteScenario removes by name; not-found when absent', () => {
        settings.saveScenario(simple('Plan'));
        expect(settings.deleteScenario('PLAN')).toEqual({ ok: true });
        expect(settings.getScenarios()).toEqual({});
        expect(settings.deleteScenario('Plan')).toEqual({ ok: false, reason: 'not-found' });
    });

    describe('import / export', () => {
        const json = (doc: unknown) => JSON.stringify(doc);

        test('preview describes phases, spending actions and limits without saving', () => {
            const result = settings.previewScenarioImport(json(template('exhibitionDoubleDip'))) as PreviewAccepted;
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
                settings: ['exposure', 'exposureTarget', 'useFinalWindowExposure', 'autoSubmit', 'autoBoost'],
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
            const result = settings.previewScenarioImport(json(template('morningSwap'))) as PreviewAccepted;
            expect(result.exists).toBe(true);
            expect(result.preview).toEqual(
                expect.objectContaining({
                    limits: { swaps: 10 },
                    spending: [{ phase: 'main', rule: 'morning-swap', action: 'swap' }],
                }),
            );
        });

        test('preview points out the phase settings worth a second look', () => {
            const doc = {
                ...simple(),
                phases: { main: { settings: { chosenPhotos: ['a'.repeat(32)], chosenPhotosOnly: true } } },
            };
            const result = settings.previewScenarioImport(json(doc)) as PreviewAccepted;
            expect(result.preview.flagged).toEqual([
                { phase: 'main', key: 'chosenPhotos' },
                { phase: 'main', key: 'chosenPhotosOnly' },
            ]);
        });

        describe('photo pools', () => {
            const pooled = (...names: string[]) => ({
                ...simple(),
                phases: {
                    main: {},
                    ...Object.fromEntries(names.map((name, at) => [`feed${at}`, { photoPool: { name, only: true } }])),
                },
            });

            test('a document names its pools once each; nothing of the account’s photos is in an export', () => {
                settings.setPhotoPool('Wall', ['secretPhotoId1', 'secretPhotoId2']);
                settings.saveScenario(pooled('Wall', 'Wall', 'Fence'));
                const exported = settings.exportScenarioWithNotes('Plan');
                expect(exported?.json).toContain('"name": "Wall"');
                expect(exported?.json).not.toContain('secretPhotoId');
                expect(settings.describeScenario(settings.getScenario('Plan')!).pools).toEqual(['Wall', 'Fence']);
            });

            test('the preview and the result tell which pools this account lacks, and it is not an error', () => {
                settings.setPhotoPool('Wall', ['a']);
                const preview = settings.previewScenarioImport(json(pooled('Wall', 'Fence'))) as PreviewAccepted;
                expect(preview.unboundPools).toEqual(['Fence']);
                expect(settings.importScenario(json(pooled('Wall', 'Fence')))).toEqual({
                    ok: true,
                    name: 'Plan',
                    unboundPools: ['Fence'],
                });
                expect(Object.keys(settings.getScenarios())).toEqual(['Plan']);
            });

            test('a scenario with no pool has nothing to bind', () => {
                expect((settings.previewScenarioImport(json(simple())) as PreviewAccepted).unboundPools).toEqual([]);
                expect(settings.describeScenario(simple() as never).pools).toEqual([]);
            });
        });

        test('preview of a document without a description', () => {
            expect((settings.previewScenarioImport(json(simple())) as PreviewAccepted).preview.description).toBe('');
        });

        test('preview refuses bad JSON and invalid documents', () => {
            expect((settings.previewScenarioImport('{') as PreviewRefused).issues[0].message).toContain(
                'Not valid JSON',
            );
            expect(
                (settings.previewScenarioImport(json({ ...simple(), version: 2 })) as PreviewRefused).issues[0].path,
            ).toBe('version');
        });

        test('import stores; a name clash needs overwrite', () => {
            expect(settings.importScenario(json(simple()))).toEqual({ ok: true, name: 'Plan', unboundPools: [] });
            expect(settings.importScenario(json(simple()))).toEqual({
                ok: false,
                issues: [expect.objectContaining({ path: 'name' })],
            });
            expect(
                settings.importScenario(json(simple()), { overwrite: true, expectedDefinitionRevision: revision() }).ok,
            ).toBe(true);
            expect(settings.importScenario('').ok).toBe(false);
        });

        test('export round-trips through import', () => {
            settings.saveScenario(template('topTenTurbo'));
            const text = settings.exportScenario('turbo in the top 10')!;
            expect(text.endsWith('\n')).toBe(true);
            settings.deleteScenario('Turbo in the top 10');
            expect(settings.importScenario(text).ok).toBe(true);
            expect(settings.getScenario('Turbo in the top 10')).toEqual(JSON.parse(text));
            expect(settings.exportScenario('missing')).toBeNull();
        });

        // printDocument prints an export without redacting it, on the ground that a scenario holds no credentials.
        test('an exported scenario holds no key a log would redact, no sign-in and no account identifier', () => {
            const { SENSITIVE_KEY_RE } =
                require('../../src/ts/core/logger/sanitize') as typeof import('../../src/ts/core/logger/sanitize');
            const { PRIVATE_SETTING_KEYS } =
                require('../../src/ts/core/format/settingsLogMask') as typeof import('../../src/ts/core/format/settingsLogMask');
            const keysOf = (value: unknown): string[] =>
                value !== null && typeof value === 'object'
                    ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
                    : [];
            const plan = simple('Photos');
            const withPhotos = {
                ...plan,
                phases: { main: { ...plan.phases.main, settings: { chosenPhotos: ['a'.repeat(32)] } } },
            };
            settings.saveScenario(withPhotos);
            for (const { id } of SCENARIO_TEMPLATES) settings.saveScenario({ ...template(id), name: `Export ${id}` });

            const exported = [withPhotos.name, ...SCENARIO_TEMPLATES.map(({ id }) => `Export ${id}`)].map(
                (name) => settings.exportScenario(name)!,
            );
            expect(exported).toHaveLength(SCENARIO_TEMPLATES.length + 1);
            expect(settings.getScenario('Photos')?.phases.main.settings).toEqual({ chosenPhotos: ['a'.repeat(32)] });
            for (const text of exported) {
                expect(text).not.toBe('null');
                for (const key of keysOf(JSON.parse(text))) {
                    expect(key).not.toMatch(SENSITIVE_KEY_RE);
                    expect(key).not.toBe('apiHeaders');
                    expect(key).not.toBe('auth');
                    expect(PRIVATE_SETTING_KEYS.has(key)).toBe(false);
                    expect(key).not.toBe('chosenPhotos');
                }
            }
        });
    });
});

describe('settings facade — scenario assignment', () => {
    let store: MemoryStore;
    const blob = (): ConfigV2 => parseJsonAs(store.value!, isConfig);

    beforeEach(async () => {
        store = installHeadlessStore();
        // The stores keep what they last read: the progress a test left is not this one's.
        const storage =
            require('../../src/ts/core/settings/storage') as typeof import('../../src/ts/core/settings/storage');
        await storage.discardPendingWrites();
        storage.resumeWrites();
        settings.rememberChallengeTitles([
            { id: 7, title: 'Big show', type: 'exhibition' },
            { id: 8, title: 'Other' },
        ]);
        settings.saveScenario(simple('Plan'));
    });

    afterEach(() => {
        removeHeadlessStore();
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
        settings.saveChallengeProfile('Show tactic', { scenario: 'Plan', autoSubmit: true });
        settings.setTitleRules([
            { type: 'exhibition', scenario: 'Plan' },
            { title: 'Other', scenario: 'PLAN', autoSubmit: true },
            { title: 'Unrelated', scenario: 'Something else' },
        ]);
    };

    test('a rename moves every assignment to the new name', () => {
        assignEverywhere();
        expect(settings.renameScenario('Plan', 'Show plan').ok).toBe(true);
        const stored = blob();
        expect(stored.challenges['8'].values?.scenario).toBe('Show plan');
        expect(stored.profiles['Show tactic']).toMatchObject({ scenario: 'Show plan' });
        expect(stored.rules.map((r) => r.scenario)).toEqual(['Show plan', 'Show plan', 'Something else']);
    });

    test('a delete clears every assignment and drops rules left with nothing to do', () => {
        assignEverywhere();
        expect(settings.deleteScenario('Plan')).toEqual({ ok: true });
        const stored = blob();
        expect(stored.challenges['8']?.values?.scenario).toBeUndefined();
        expect(stored.profiles['Show tactic']).toEqual({ autoSubmit: true });
        expect(stored.rules).toEqual([
            expect.objectContaining({ title: 'Other', autoSubmit: true }),
            expect.objectContaining({ title: 'Unrelated', scenario: 'Something else' }),
        ]);
        expect(stored.rules[0].scenario).toBeUndefined();
        expect(settings.getScenario('Plan')).toBeNull();
    });

    test('a delete keeps a rule that still has a profile or tags', () => {
        settings.saveChallengeProfile('Show tactic', { autoSubmit: true });
        settings.setTitleRules([
            { type: 'exhibition', scenario: 'Plan', profile: 'Show tactic' },
            { title: 'Other', scenario: 'Plan', mustIncludeTags: ['sea'] },
        ]);
        settings.deleteScenario('Plan');
        expect(blob().rules).toHaveLength(2);
    });

    test('a delete leaves the progress record as it was', () => {
        settings.setChallengeOverride('scenario', '8', 'Plan');
        const { scenarioStateLedger, initialState } =
            require('../../src/ts/core/scenarioStateStore') as typeof import('../../src/ts/core/scenarioStateStore');
        scenarioStateLedger.change('8', () => ({ ...initialState('Plan', 'main', 1), memory: { held: 'z' } }));
        const before = scenarioStateLedger.get('8').state;
        expect(settings.deleteScenario('Plan')).toEqual({ ok: true });
        expect(scenarioStateLedger.get('8').state).toEqual(before);
    });

    test('a delete that the preflight refuses clears nothing', () => {
        assignEverywhere();
        const { scenarioStateLedger, initialState } =
            require('../../src/ts/core/scenarioStateStore') as typeof import('../../src/ts/core/scenarioStateStore');
        scenarioStateLedger.change('8', () => ({
            ...initialState('Plan', 'main', 1),
            inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' },
        }));
        const before = store.value;
        expect(settings.deleteScenario('Plan')).toEqual({ ok: false, reason: 'unresolved-work' });
        expect(store.value).toBe(before);
    });

    test('a rename copes with corrupted assignment containers', () => {
        const raw = parseJsonAs(store.value!, isConfig);
        raw.profiles = invalid({ Broken: null, Fine: { scenario: 'Plan' } });
        store.value = JSON.stringify(raw);
        expect(settings.renameScenario('Plan', 'Renamed').ok).toBe(true);
        expect(blob().profiles).toEqual({ Broken: null, Fine: { scenario: 'Renamed' } });
    });

    test('a delete copes with missing or corrupted assignment containers', () => {
        const raw = parseJsonAs(store.value!, isConfig);
        raw.profiles = invalid({ Broken: null });
        raw.rules = invalid('not a list');
        store.value = JSON.stringify(raw);
        expect(settings.deleteScenario('Plan')).toEqual({ ok: true });
    });
});

describe('settings facade — scenarios when the save fails', () => {
    let scenarios: typeof scenariosModule;

    beforeEach(() => {
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/core/settings/persistence', () => {
                const actual = jest.requireActual<typeof import('../../src/ts/core/settings/persistence')>(
                    '../../src/ts/core/settings/persistence',
                );
                return { ...actual, loadSettings: () => actual.loadSettings(), saveSettings: () => false };
            });
            scenarios = require('../../src/ts/core/settings/scenarios') as typeof scenarios;
        });
    });

    afterEach(() => jest.dontMock('../../src/ts/core/settings/persistence'));

    test('save and delete report the failure', () => {
        expect((scenarios.saveScenario(simple()) as SaveRefused).issues[0].message).toContain('could not be saved');
    });

    test('delete reports not-saved when the save fails', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/core/settings/persistence', () => {
                const actual = jest.requireActual<typeof import('../../src/ts/core/settings/persistence')>(
                    '../../src/ts/core/settings/persistence',
                );
                const blob = actual.loadSettings();
                blob.scenarios = { Plan: simple() };
                return { ...actual, loadSettings: () => structuredClone(blob), saveSettings: () => false };
            });
            const isolated = require('../../src/ts/core/settings/scenarios') as typeof scenariosModule;
            expect(isolated.deleteScenario('Plan')).toEqual({ ok: false, reason: 'not-saved' });
        });
    });
});
