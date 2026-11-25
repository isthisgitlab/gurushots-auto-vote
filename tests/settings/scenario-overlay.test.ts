/**
 * The scenario phase-settings overlay in getEffectiveSetting: while a
 * challenge is in a phase of its assigned scenario, that phase's settings win
 * over every other layer; otherwise nothing changes, and stored overrides are
 * never touched.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/core/settings');
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import { isNumber, isRecordOf, isShape, isUnknown, parseJsonAs } from '../helpers/parseJson';
import { invalid } from '../helpers/invalid';
import { phaseFingerprint } from '../../src/ts/core/settings/scenarioOverlay';
import type * as expressionsModule from '../../src/ts/core/scenarios/expressions';
import type { ExpressionContext } from '../../src/ts/core/scenarios/expressions';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
const { evaluateExpression, unknownOf } =
    require('../../src/ts/core/scenarios/expressions') as typeof expressionsModule;
const { scenarioStateLedger, mockScenarioStateLedger, initialState } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;

jest.mock('../../src/ts/core/logger', () => {
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
        challengeTag: jest.fn((id: string | number) => `[${id}]`),
    };
});

const plan = {
    name: 'Plan',
    version: 1,
    start: 'buildup',
    phases: {
        buildup: { settings: { exposure: 10, exposureTarget: 12, autoSubmit: false } },
        done: {},
    },
};

describe('scenario phase-settings overlay', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
        settings.setGlobalDefault('exposure', 100);
        settings.setGlobalDefault('exposureTarget', 100);
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    const assign = () => {
        settings.saveScenario(plan);
        settings.setChallengeOverride('scenario', '7', 'Plan');
    };

    test('no stored scenarios: settings are untouched', () => {
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('in a phase, its settings win over the manual override and rules', () => {
        assign();
        settings.setChallengeOverride('autoSubmit', '7', true);
        settings.setTitleRules([{ type: 'exhibition', autoSubmit: true }]);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1000));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        expect(settings.getEffectiveSetting('exposureTarget', 7)).toBe(12);
        expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(false);
        // Keys the phase does not set, the global view and the stored overrides are unchanged.
        expect(settings.getEffectiveSetting('autoBoost', '7')).toBe(settings.getGlobalDefault('autoBoost'));
        expect(settings.getEffectiveSetting('exposure')).toBe(100);
        expect(settings.getChallengeOverrides('7')).toEqual({ scenario: 'Plan', autoSubmit: true });
    });

    test('the assignment itself is never overlaid', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1000));
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
    });

    test('leaving to a phase without settings restores normal values', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'done', 1000));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test.each([
        ['no state yet', () => {}],
        ['state for another scenario', () => scenarioStateLedger.set(7, initialState('Other', 'buildup', 1))],
        ['a phase the scenario no longer has', () => scenarioStateLedger.set(7, initialState('Plan', 'gone', 1))],
        [
            'unreadable state',
            () => {
                store.keys.set('gs_scenario_state', '{broken');
            },
        ],
    ])('no overlay with %s', (label, arrange) => {
        assign();
        arrange();
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('no overlay when the challenge has no scenario, or an unknown one', () => {
        settings.saveScenario(plan);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
        settings.setChallengeOverride('scenario', '7', 'Missing');
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('no overlay when the stored scenario no longer validates', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        const blob = parseJsonAs(
            store.value!,
            isShape<{ scenarios: Record<string, { version: number }> }>({
                scenarios: isRecordOf(isShape<{ version: number }>({ version: isNumber })),
            }),
        );
        blob.scenarios.Plan.version = 99;
        store.value = JSON.stringify(blob);
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('state name matching is case-insensitive', () => {
        assign();
        scenarioStateLedger.set(7, initialState('PLAN', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
    });

    test('mock mode reads the in-memory ledger, never the persisted one', async () => {
        assign();
        settings.setSetting('mock', true);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
        mockScenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        await mockScenarioStateLedger.remove(7);
    });
});

describe('a scenario phase with a photo pool', () => {
    let store: MemoryStore;
    const pool = {
        name: 'Plan',
        version: 1,
        start: 'feed',
        phases: { feed: { photoPool: { name: 'Wall', only: true } }, done: {} },
    };

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
        expect(settings.saveScenario(pool)).toMatchObject({ ok: true });
        settings.setChallengeOverride('scenario', '7', 'Plan');
        settings.setPhotoPool('Wall', ['p1', 'p2']);
        scenarioStateLedger.set(7, initialState('Plan', 'feed', 1000));
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    test('the pool is above the challenge’s own Chosen Photos, which stay stored and untouched', () => {
        settings.setChallengeOverride('chosenPhotos', '7', ['own1']);
        settings.setChallengeOverride('chosenPhotosInOrder', '7', true);
        expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['p1', 'p2']);
        expect(settings.getEffectiveSetting('chosenPhotosOnly', '7')).toBe(true);
        expect(settings.getEffectiveSetting('chosenPhotosInOrder', '7')).toBe(false);
        expect(settings.getChallengeOverrides('7')).toMatchObject({
            chosenPhotos: ['own1'],
            chosenPhotosInOrder: true,
        });
        scenarioStateLedger.set(7, initialState('Plan', 'done', 1000));
        expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['own1']);
    });

    test('the challenge’s own list is consumed as it always was, whatever the pool says', () => {
        settings.setChallengeOverride('chosenPhotos', '7', ['own1', 'own2']);
        expect(settings.consumeChosenPhotos('7', ['own1'])).toBe(true);
        expect(settings.getChallengeOverride('chosenPhotos', '7')).toEqual(['own2']);
        expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['p1', 'p2']);
    });

    test('a pool phase never reads the progress of another phase', () => {
        scenarioStateLedger.set(7, {
            ...initialState('Plan', 'feed', 1000),
            poolProgress: { done: { consumed: ['p1', 'p2'], reserved: [] } },
        });
        expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['p1', 'p2']);
    });

    test('the pool is the account’s: saving it again changes what the phase offers, never what it has given out', () => {
        settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] });
        settings.setPhotoPool('Wall', ['p3', 'p2', 'p1']);
        expect(settings.getEffectiveSetting('chosenPhotos', '7')).toEqual(['p3', 'p2']);
        expect(store.keys.get('gs_scenario_state')).toContain('"consumed":["p1"]');
    });
});

/**
 * Phases with bindings or a profile: the overlay is read through the settings the owner published into the scenario
 * ledger, and with no valid publication the settings are unavailable, never inherited.
 */
describe('scenario phase bindings and profile', () => {
    let store: MemoryStore;
    let nowMs = 1_600_000;

    const percent = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'percent' });
    const baseOf = (key: string) => invalid<ScenarioExpr>({ kind: 'setting', key, view: 'base' });
    const plus = (key: string, amount: number) =>
        invalid<ScenarioExpr>({ kind: 'add', left: baseOf(key), right: percent(amount) });

    // The plan's example: base exposure 40, effective 60, the stored challenge value stays 40.
    const bindingPlan = (extra: Record<string, unknown> = {}) => ({
        name: 'Plan',
        version: 1,
        start: 'push',
        phases: {
            push: {
                settings: { exposureTarget: 90 },
                bindings: { exposure: plus('exposure', 20) },
                ...extra,
            },
            rest: {},
        },
    });

    const assign = (doc: unknown = bindingPlan()) => {
        // A replacement states the revision of the collection it was edited on.
        expect(
            settings.saveScenario(doc, {
                expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
            }),
        ).toEqual({ ok: true, name: 'Plan' });
        settings.setChallengeOverride('scenario', '7', 'Plan');
        scenarioStateLedger.set(7, initialState('Plan', 'push', 1000));
    };

    /** What the runner does: resolves the phase's bindings and prepares the overlay. */
    const prepare = (validUntil: number | null = null, at = 1500) => {
        const scenario = settings.getScenario('Plan') as ScenarioDocument;
        const state = scenarioStateLedger.get(7).state as ScenarioState;
        const bindings = scenario.phases[state.phase].bindings ?? {};
        return {
            scenario,
            state,
            result: settings.prepareScenarioSnapshot(
                7,
                scenario,
                state,
                (readBase) => ({
                    bound: Object.fromEntries(
                        Object.entries(bindings).map(([key, expression]) => [
                            key,
                            evaluateExpression(expression, {
                                challenge: invalid<Challenge>({ id: 7 }),
                                state,
                                now: at,
                                timezone: 'UTC',
                                readSetting: readBase,
                            }),
                        ]),
                    ),
                    validUntil,
                }),
                at,
            ),
        };
    };

    const publish = (validUntil: number | null = null, at = 1500) => {
        const { state, result } = prepare(validUntil, at);
        if (!result.ok || !result.snapshot.publication) throw new Error('nothing to publish');
        expect(scenarioStateLedger.set(7, { ...state, published: result.snapshot.publication })).toBe('saved');
    };

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
        settings.setGlobalDefault('exposure', 30);
        settings.setGlobalDefault('exposureTarget', 100);
        settings.setChallengeOverride('exposure', '7', 40);
        jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        nowMs = 1_600_000;
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    test('base 40, effective 60, and the stored challenge value stays 40', () => {
        assign();
        publish();
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(60);
        expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(90);
        const base = settings.readScenarioSetting('exposure', 'base', '7');
        const effective = settings.readScenarioSetting('exposure', 'effective', '7');
        expect(base).toEqual({ state: 'known', value: { kind: 'number', value: 40, quantity: 'percent' } });
        expect(effective).toEqual({ state: 'known', value: { kind: 'number', value: 60, quantity: 'percent' } });
        expect(settings.getScenarioBaseSettings('7').exposure).toEqual(base);
        expect(settings.getScenarioBaseSettings().exposure).toMatchObject({ value: { value: 30 } });
        expect(settings.getChallengeOverrides('7')).toEqual({ scenario: 'Plan', exposure: 40 });
        expect(settings.getEffectiveSetting('exposure')).toBe(30);
        // The published record holds only the resolved binding; the literal is read from the document.
        const { published } = scenarioStateLedger.get(7).state as ScenarioState;
        expect(published).toMatchObject({
            revision: 1,
            phase: 'push',
            phaseEnteredAt: 1000,
            observedAt: 1500,
            validUntil: null,
            bindings: { exposure: 60 },
            profile: null,
        });
        expect(published?.documentFingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    test('with nothing published its settings are unavailable, never inherited', () => {
        assign();
        expect(() => settings.getEffectiveSetting('exposure', '7')).toThrow(settings.ScenarioSettingUnavailableError);
        expect(() => settings.getEffectiveSetting('autoBoost', 7)).toThrow(/nothing is published/);
        const failure = (() => {
            try {
                settings.getEffectiveSetting('exposure', '7');
            } catch (error) {
                return error;
            }
            return null;
        })();
        expect(failure).toMatchObject({
            name: 'ScenarioSettingUnavailableError',
            settingKey: 'exposure',
            challengeId: '7',
            reason: 'nothing is published for this phase yet',
        });
        expect(settings.readScenarioSetting('exposure', 'effective', '7')).toEqual({
            state: 'unknown',
            reason: 'nothing is published for this phase yet',
            dependencies: ['setting:exposure'],
        });
        // The base view is the normal resolution and stays readable.
        expect(settings.readScenarioSetting('exposure', 'base', '7')).toMatchObject({ state: 'known' });
        expect(settings.scenarioSubjectAvailable('7')).toBe(false);
        expect(settings.scenarioSubjectReason(7)).toBe('nothing is published for this phase yet');
    });

    test.each([
        ['a setting no phase may write', 'manualPhotosOnly'],
        ['a setting that is not per challenge', 'language'],
        ['the assignment itself', 'scenario'],
    ])('%s still resolves as it always did', (label, key) => {
        assign();
        expect(() => settings.getEffectiveSetting(key, '7')).not.toThrow();
    });

    test('another challenge, and a read with no challenge, resolve as they always did', () => {
        assign();
        expect(settings.getEffectiveSetting('exposure', '8')).toBe(30);
        expect(settings.getEffectiveSetting('exposure')).toBe(30);
        expect(settings.scenarioSubjectAvailable('8')).toBe(true);
        expect(settings.scenarioSubjectAvailable(null)).toBe(true);
        expect(settings.scenarioSubjectReason('')).toBeNull();
        expect(settings.readScenarioSetting('exposure', 'effective')).toMatchObject({
            state: 'known',
            value: { value: 30 },
        });
    });

    test('a phase with literals only needs nothing published', () => {
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: { push: { settings: { exposure: 10, exposureTarget: 12 } } },
        });
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        expect(settings.scenarioOverlayStatus('7')).toEqual({
            bound: false,
            available: true,
            reason: null,
            sources: { patch: [], literals: ['exposure', 'exposureTarget'], bindings: [], profile: [] },
            published: null,
        });
    });

    test('an expired publication is unavailable', () => {
        assign();
        publish(1700);
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(60);
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        nowMs = 1_700_000;
        expect(settings.scenarioSubjectReason('7')).toBe('the published settings of this phase have expired');
        expect(() => settings.getEffectiveSetting('exposure', '7')).toThrow(/expired/);
        // null never expires
        publish(null);
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
    });

    test('a document edit after publishing makes the publication unavailable', () => {
        assign();
        publish();
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        settings.saveScenario(bindingPlan({ settings: { exposureTarget: 95 } }), {
            expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
        });
        expect(settings.scenarioSubjectReason('7')).toBe(
            'the scenario or its profile changed after its settings were published',
        );
        expect(() => settings.getEffectiveSetting('exposure', '7')).toThrow(settings.ScenarioSettingUnavailableError);
    });

    test('a publication for another visit to the phase, or another phase, is unavailable', () => {
        assign();
        publish();
        const { state } = scenarioStateLedger.get(7);
        scenarioStateLedger.set(7, { ...(state as ScenarioState), phaseEnteredAt: 2000 });
        expect(settings.scenarioSubjectReason('7')).toBe('the published settings are from an earlier visit to a phase');
        publish();
        const next = scenarioStateLedger.get(7).state as ScenarioState;
        scenarioStateLedger.set(7, { ...next, phase: 'rest' });
        // a phase without bindings or a profile needs no publication: ordinary reads
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(40);
    });

    test('a malformed publication makes it unreadable, not the whole record', () => {
        assign();
        publish();
        const blob = parseJsonAs(store.keys.get('gs_scenario_state')!, isRecordOf(isRecordOf(isUnknown)));
        blob['7'].published = { revision: 'x' };
        store.keys.set('gs_scenario_state', JSON.stringify(blob));
        const read = scenarioStateLedger.get(7);
        expect(read.corrupt).toBe(false);
        expect(read.state).toMatchObject({ phase: 'push', publicationUnreadable: true });
        expect(read.state?.published).toBeUndefined();
        expect(settings.scenarioSubjectReason('7')).toBe('the published settings of this phase are malformed');
        // the next write drops it and publishing again repairs it
        publish();
        expect(scenarioStateLedger.get(7).state?.publicationUnreadable).toBeUndefined();
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
    });

    test('unreadable progress makes a scenario with a bound phase unavailable, and one without it ordinary', () => {
        assign();
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.scenarioSubjectReason('7')).toBe('the saved progress of this challenge cannot be read');
        expect(() => settings.getEffectiveSetting('exposure', '7')).toThrow(settings.ScenarioSettingUnavailableError);
        expect(settings.scenarioOverlayStatus('7')).toMatchObject({ bound: true, available: false });
        expect(settings.readScenarioSetting('exposure', 'effective', '7')).toMatchObject({ state: 'unknown' });
        // A scenario is replaced only over progress that can be read: it is repaired (reset) first.
        store.keys.set('gs_scenario_state', '{}');
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: { push: { settings: { exposure: 10, exposureTarget: 12 } } },
        });
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(40);
    });

    test('a publication missing a binding, or naming another profile, is unavailable', () => {
        assign();
        publish();
        const state = scenarioStateLedger.get(7).state as ScenarioState;
        const published = state.published as NonNullable<ScenarioState['published']>;
        scenarioStateLedger.set(7, { ...state, published: { ...published, bindings: {} } });
        expect(settings.scenarioSubjectReason('7')).toBe(
            'the published settings do not match the bindings of this phase',
        );
        scenarioStateLedger.set(7, { ...state, published: { ...published, profile: 'Other' } });
        expect(settings.scenarioSubjectReason('7')).toBe('the published settings name another profile');
    });

    test('mock mode reads the in-memory ledger', async () => {
        assign();
        publish();
        settings.setSetting('mock', true);
        expect(settings.scenarioSubjectAvailable('7')).toBe(true);
        mockScenarioStateLedger.set(7, initialState('Plan', 'push', 1));
        expect(settings.scenarioSubjectAvailable('7')).toBe(false);
        await mockScenarioStateLedger.remove(7);
    });

    test('typed reads: an unknown setting, a restricted projection, and the base view with no challenge', () => {
        assign();
        expect(settings.readScenarioSetting('nonsense', 'base', '7')).toEqual({
            state: 'unknown',
            reason: 'setting-unknown',
            dependencies: ['setting:nonsense'],
        });
        const projection = settings.getScenarioCapabilities().settings.find((row) => row.read === 'projection');
        expect(projection).toBeDefined();
        expect(settings.readScenarioSetting(String(projection?.key), 'base', '7')).toMatchObject({
            state: 'unknown',
            reason: 'setting-not-readable',
        });
        expect(settings.getScenarioBaseSettings().exposure).toMatchObject({ value: { value: 30 } });
    });

    test('an effective read of a setting the phase cannot write is the base value, even with no valid publication', () => {
        assign();
        expect(settings.readScenarioSetting('manualPhotosOnly', 'effective', '7')).toMatchObject({
            state: 'known',
            value: { value: false },
        });
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.readScenarioSetting('manualPhotosOnly', 'effective', '7')).toMatchObject({ state: 'known' });
    });

    test('the status of a challenge with no scenario, or no challenge, is the plain one', () => {
        const none = {
            bound: false,
            available: true,
            reason: null,
            sources: { patch: [], literals: [], bindings: [], profile: [] },
            published: null,
        };
        expect(settings.scenarioOverlayStatus(null)).toEqual(none);
        expect(settings.scenarioOverlayStatus('8')).toEqual(none);
    });

    describe('what the owner prepares', () => {
        test('a phase with literals only prepares nothing to publish, and its reads are the document over the base', () => {
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { settings: { exposure: 10, exposureTarget: 12 } } },
            });
            const { result } = prepare();
            if (!result.ok) throw new Error('prepared');
            expect(result.snapshot.publication).toBeNull();
            expect(result.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 10 } });
            expect(result.snapshot.readSetting('exposure', 'base')).toMatchObject({ value: { value: 40 } });
            expect(result.snapshot.readSetting('boostTime', 'effective')).toMatchObject({ state: 'known' });
            expect(result.snapshot.readSetting('nonsense', 'base')).toMatchObject({ reason: 'setting-unknown' });
        });

        test('reads over the prepared overlay: effective with the phase, base without it', () => {
            assign();
            const { result } = prepare(1800);
            if (!result.ok) throw new Error('prepared');
            const { publication, readSetting } = result.snapshot;
            expect(publication).toMatchObject({ validUntil: 1800, bindings: { exposure: 60 } });
            expect(readSetting('exposure', 'effective')).toMatchObject({ value: { value: 60 } });
            expect(readSetting('exposureTarget', 'effective')).toMatchObject({ value: { value: 90 } });
            expect(readSetting('exposure', 'base')).toMatchObject({ value: { value: 40 } });
            expect(readSetting('exposureTarget', 'base')).toMatchObject({ value: { value: 100 } });
        });

        test('a binding reads the base view only', () => {
            assign();
            const scenario = settings.getScenario('Plan') as ScenarioDocument;
            const state = scenarioStateLedger.get(7).state as ScenarioState;
            let seen: unknown[] = [];
            settings.prepareScenarioSnapshot(
                7,
                scenario,
                state,
                (readBase) => {
                    seen = [
                        readBase('exposure', 'base'),
                        readBase('exposure', 'effective'),
                        readBase('nonsense', 'base'),
                    ];
                    return { bound: { exposure: unknownOf('test', []) }, validUntil: null };
                },
                1500,
            );
            expect(seen).toEqual([
                { state: 'known', value: { kind: 'number', value: 40, quantity: 'percent' } },
                { state: 'unknown', reason: 'binding-reads-base-only', dependencies: ['setting:exposure'] },
                { state: 'unknown', reason: 'setting-unknown', dependencies: ['setting:nonsense'] },
            ]);
        });

        test('a phase with nothing of its own prepares nothing, and reads the base', () => {
            assign();
            const scenario = settings.getScenario('Plan') as ScenarioDocument;
            const result = settings.prepareScenarioSnapshot(
                7,
                scenario,
                { ...initialState('Plan', 'rest', 1000) },
                () => ({ bound: {}, validUntil: null }),
                1500,
            );
            if (!result.ok) throw new Error('prepared');
            expect(result.snapshot.publication).toBeNull();
            expect(result.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 40 } });
        });

        test('republishing counts the revision on', () => {
            assign();
            publish();
            publish();
            expect(scenarioStateLedger.get(7).state?.published?.revision).toBe(2);
        });

        test.each([
            [
                'an unknown binding',
                invalid<ScenarioExpr>({ kind: 'fact', name: 'boost.state' }),
                'boost-state-unreadable',
            ],
            [
                'a value of another quantity',
                invalid<ScenarioExpr>({ kind: 'literal', value: 2, quantity: 'duration', unit: 'hours' }),
                'type-mismatch',
            ],
            ['a value its setting refuses', plus('exposure', 70), 'Too big: expected number to be <=100'],
        ])('%s blocks the phase: no partial overlay', (label, expression, reason) => {
            const doc = bindingPlan();
            doc.phases.push.bindings = { exposure: expression };
            // an expression the document validator would refuse is stored as the engine reads it back: written raw
            const settingsBlob = parseJsonAs(
                store.value!,
                isShape<{ scenarios: Record<string, unknown> }>({ scenarios: isRecordOf(isUnknown) }),
            );
            settingsBlob.scenarios.Plan = { ...doc, name: 'Plan' };
            store.value = JSON.stringify(settingsBlob);
            const scenario = invalid<ScenarioDocument>(doc);
            const state = initialState('Plan', 'push', 1000);
            const result = settings.prepareScenarioSnapshot(
                7,
                scenario,
                state,
                () => ({
                    bound: {
                        exposure: evaluateExpression(
                            expression,
                            invalid<ExpressionContext>({
                                readSetting: () => ({
                                    state: 'known',
                                    value: { kind: 'number', value: 40, quantity: 'percent' },
                                }),
                            }),
                        ),
                    },
                    validUntil: null,
                }),
                1500,
            );
            expect(result).toEqual({ ok: false, key: 'exposure', reason });
        });

        test('an absent binding blocks the phase and an in-range binding raises a same-source target', () => {
            assign();
            const scenario = settings.getScenario('Plan') as ScenarioDocument;
            const state = scenarioStateLedger.get(7).state as ScenarioState;
            const run = (bound: Record<string, unknown>) =>
                settings.prepareScenarioSnapshot(
                    7,
                    scenario,
                    state,
                    () => ({ bound: invalid(bound), validUntil: null }),
                    1500,
                );
            expect(run({ exposure: { state: 'absent', reason: 'not-present' } })).toEqual({
                ok: false,
                key: 'exposure',
                reason: 'absent: not-present',
            });
            const result = run({
                exposure: { state: 'known', value: { kind: 'number', value: 95, quantity: 'percent' } },
            });
            if (!result.ok) throw new Error('phase did not prepare');
            expect(result.snapshot.readSetting('exposureTarget', 'effective')).toMatchObject({ value: { value: 95 } });
        });
    });

    describe('a phase profile', () => {
        const profile = { autoBoost: true, boostTime: 120, exposure: 20, exposureTarget: 30 };

        beforeEach(() => {
            settings.saveChallengeProfile('Tactic', profile);
        });

        const withProfile = (phase: Record<string, unknown>) =>
            assign({ name: 'Plan', version: 1, start: 'push', phases: { push: phase } });

        test('its values sit below the phase literals and bindings and above the override, rules and defaults', () => {
            settings.setChallengeOverride('boostTime', '7', 900);
            settings.setTitleRules([{ type: 'exhibition', autoSubmit: true }]);
            withProfile({
                profile: 'Tactic',
                settings: { exposureTarget: 90 },
                bindings: { exposure: plus('exposure', 20) },
            });
            publish();
            // binding over the profile, literal over the profile
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(60);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(90);
            // the profile over the override, over the rule and the default
            expect(settings.getEffectiveSetting('autoBoost', '7')).toBe(true);
            expect(settings.getEffectiveSetting('boostTime', '7')).toBe(120);
            // below the overlay: override, then the rule, then the default
            expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(true);
            expect(settings.getEffectiveSetting('onlyBoost', '7')).toBe(false);
            expect(settings.scenarioOverlayStatus('7')).toEqual({
                bound: true,
                available: true,
                reason: null,
                sources: {
                    patch: [],
                    literals: ['exposureTarget'],
                    bindings: ['exposure'],
                    profile: ['autoBoost', 'boostTime', 'exposure', 'exposureTarget'],
                },
                published: { revision: 1, observedAt: 1500, validUntil: null, profile: 'Tactic' },
            });
            // the profile and the stored values are untouched
            expect(settings.getChallengeProfiles().Tactic).toEqual(profile);
            expect(settings.getChallengeOverrides('7')).toMatchObject({ boostTime: 900, exposure: 40 });
        });

        test('a profile alone is a bound phase and is published', () => {
            withProfile({ profile: 'tactic' });
            expect(settings.scenarioSubjectAvailable('7')).toBe(false);
            const { result } = prepare();
            if (!result.ok) throw new Error('phase did not prepare');
            expect(result.snapshot.readSetting('boostTime', 'effective')).toMatchObject({ value: { value: 120 } });
            publish();
            expect(settings.getEffectiveSetting('boostTime', '7')).toBe(120);
            expect(settings.readScenarioSetting('boostTime', 'effective', '7')).toMatchObject({
                value: { value: 120 },
            });
            expect(scenarioStateLedger.get(7).state?.published?.profile).toBe('Tactic');
        });

        test('editing the profile after publishing makes the publication unavailable', () => {
            withProfile({ profile: 'Tactic' });
            publish();
            settings.saveChallengeProfile('Tactic', { ...profile, boostTime: 60 });
            expect(settings.scenarioSubjectReason('7')).toBe(
                'the scenario or its profile changed after its settings were published',
            );
        });

        test.each([
            ['missing', () => settings.deleteChallengeProfile('Tactic'), 'profile-unavailable: Tactic'],
            [
                'malformed',
                () => {
                    const blob = parseJsonAs(
                        store.value!,
                        isShape<{ profiles: Record<string, unknown> }>({ profiles: isRecordOf(isUnknown) }),
                    );
                    blob.profiles.Tactic = ['bad'];
                    store.value = JSON.stringify(blob);
                },
                'profile-unavailable: Tactic',
            ],
            [
                'holding a key a phase may not write',
                () => {
                    const blob = parseJsonAs(
                        store.value!,
                        isShape<{ profiles: Record<string, Record<string, unknown>> }>({
                            profiles: isRecordOf(isRecordOf(isUnknown)),
                        }),
                    );
                    blob.profiles.Tactic.manualPhotosOnly = true;
                    store.value = JSON.stringify(blob);
                },
                'profile-unavailable: Tactic',
            ],
        ])('a %s profile blocks the phase', (label, damage, reason) => {
            withProfile({ profile: 'Tactic' });
            damage();
            const { result } = prepare();
            expect(result).toEqual({ ok: false, key: null, reason });
        });

        test('a profile deleted after publishing makes the publication unavailable', () => {
            withProfile({ profile: 'Tactic' });
            publish();
            settings.deleteChallengeProfile('Tactic');
            // the fingerprint covers the stored profile, so this reads as changed
            expect(settings.scenarioSubjectReason('7')).toBe(
                'the scenario or its profile changed after its settings were published',
            );
            expect(prepare().result).toEqual({ ok: false, key: null, reason: 'profile-unavailable: Tactic' });
        });

        test('a matching publication fingerprint does not make an invalid profile usable', () => {
            withProfile({ profile: 'Tactic' });
            publish();
            const { scenario, state } = prepare();
            if (!state.published) throw new Error('missing publication');
            const config = settings.loadSettings();
            config.profiles.Tactic = { exposure: 101 };
            expect(settings.saveSettings(config)).toBe(true);
            expect(
                scenarioStateLedger.set(7, {
                    ...state,
                    published: {
                        ...state.published,
                        documentFingerprint: phaseFingerprint(config, scenario, 'push', state),
                    },
                }),
            ).toBe('saved');
            expect(settings.scenarioSubjectReason('7')).toBe('profile-unavailable: Tactic');
        });

        test('a phase profile target wins over the challenge trigger', () => {
            settings.saveChallengeProfile('Low', { exposureTarget: 35 });
            withProfile({ profile: 'Low' });
            publish();
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(35);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(35);
            expect(settings.getChallengeOverride('exposure', '7')).toBe(40);
        });

        test('a changed default flows into the published phase and respects its profile target', () => {
            settings.saveChallengeProfile('Low', { exposureTarget: 50 });
            withProfile({ profile: 'Low' });
            publish();
            expect(settings.scenarioSubjectAvailable('7')).toBe(true);
            settings.setGlobalDefault('exposure', 60);
            settings.removeChallengeOverride('exposure', '7');
            expect(settings.scenarioSubjectAvailable('7')).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(50);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(50);
        });

        test('valid sparse profiles stay available despite changes to global exposure', () => {
            settings.saveChallengeProfile('Low', { exposureTarget: 50 });
            settings.saveChallengeProfile('Tactic', { autoBoost: true, boostTime: 120 });
            settings.saveChallengeProfile('Manual', { manualPhotosOnly: true });
            expect(settings.listPhaseProfiles().sort()).toEqual(['Low', 'Tactic']);
            settings.setGlobalDefault('exposure', 60);
            expect(settings.listPhaseProfiles().sort()).toEqual(['Low', 'Tactic']);
            expect(settings.checkPhaseProfile('Low')).toMatchObject({ ok: true });
        });

        test.each([70, 95])('resolves the original base target %s against a replacement trigger', (target) => {
            settings.setGlobalDefault('exposureTarget', target);
            settings.setChallengeOverride('exposure', '7', 90);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(Math.max(target, 90));
            settings.saveChallengeProfile('Phase trigger', { exposure: 80 });
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { profile: 'Phase trigger' }, rest: {} },
            });
            const { state, result } = prepare();
            if (!result.ok || !result.snapshot.publication) throw new Error('nothing to publish');
            expect(result.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 80 } });
            expect(result.snapshot.readSetting('exposureTarget', 'effective')).toMatchObject({
                value: { value: Math.max(target, 80) },
            });
            expect(scenarioStateLedger.set(7, { ...state, published: result.snapshot.publication })).toBe('saved');
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(80);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(Math.max(target, 80));
            expect(settings.readScenarioSetting('exposureTarget', 'effective', '7')).toMatchObject({
                value: { value: Math.max(target, 80) },
            });

            scenarioStateLedger.set(7, initialState('Plan', 'rest', 1500));
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(90);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(Math.max(target, 90));
        });

        describe('grouped auto-join timing', () => {
            beforeEach(() => {
                settings.setGlobalDefault('autoJoinAfterHoursFromStart', 5);
                settings.setGlobalDefault('autoJoinAfterPercentElapsed', 25);
                settings.setGlobalDefault('autoJoinWithinHoursOfEnd', 8);
                settings.setChallengeOverride('autoJoinWithinHoursOfEnd', '7', 9);
            });

            const timing = () =>
                ['autoJoinAfterHoursFromStart', 'autoJoinAfterPercentElapsed', 'autoJoinWithinHoursOfEnd'].map((key) =>
                    settings.getEffectiveSetting(key, '7'),
                );

            test('a profile that sets one member owns the group: the others read 0, not a lower window', () => {
                settings.saveChallengeProfile('Timing', { autoJoinAfterHoursFromStart: 2 });
                withProfile({ profile: 'Timing' });
                publish();
                expect(timing()).toEqual([2, 0, 0]);
            });

            test('the phase literals and bindings are the first source, so they win the group over the profile', () => {
                settings.saveChallengeProfile('Timing', {
                    autoJoinAfterHoursFromStart: 2,
                    autoJoinAfterPercentElapsed: 40,
                });
                withProfile({ profile: 'Timing', settings: { autoJoinWithinHoursOfEnd: 3 } });
                publish();
                expect(timing()).toEqual([0, 0, 3]);
            });

            test('a binding is a member of the first source too: it converts back to its own unit', () => {
                settings.saveChallengeProfile('Timing', { autoJoinAfterPercentElapsed: 40 });
                withProfile({
                    profile: 'Timing',
                    bindings: { autoJoinWithinHoursOfEnd: baseOf('autoJoinWithinHoursOfEnd') },
                });
                publish();
                expect(scenarioStateLedger.get(7).state?.published?.bindings).toEqual({ autoJoinWithinHoursOfEnd: 9 });
                expect(timing()).toEqual([0, 0, 9]);
            });

            test('a phase that sets no member leaves the group to the layers below, as always', () => {
                withProfile({ profile: 'Tactic' });
                publish();
                expect(timing()).toEqual([5, 25, 9]);
            });

            test('a phase without bindings or a profile keeps resolving each member on its own', () => {
                assign({
                    name: 'Plan',
                    version: 1,
                    start: 'push',
                    phases: { push: { settings: { autoJoinAfterHoursFromStart: 1 } } },
                });
                expect(timing()).toEqual([1, 25, 9]);
            });
        });
    });
    describe('a runtime phase patch and profile', () => {
        /** The record as the runner leaves it after a settings action: the patch and the profile of this phase entry. */
        const change = (fields: Partial<Pick<ScenarioState, 'phasePatch' | 'phaseProfile'>>) =>
            expect(
                scenarioStateLedger.change('7', (current) => ({ ...(current as ScenarioState), ...fields })),
            ).toMatchObject({ ok: true });

        test('is the top tier: above the phase literals and bindings, the profile, the override, the rules and the defaults', () => {
            settings.saveChallengeProfile('Tactic', { autoBoost: true, boostTime: 120 });
            assign(bindingPlan({ profile: 'Tactic' }));
            change({ phasePatch: { exposureTarget: 95, boostTime: 200, autoSubmit: true } });
            publish();
            // over the phase literal (90), over the profile (120), over the default
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(95);
            expect(settings.getEffectiveSetting('boostTime', '7')).toBe(200);
            expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(true);
            // what the patch leaves alone reads from the tiers below it
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(60);
            expect(settings.getEffectiveSetting('autoBoost', '7')).toBe(true);
            expect(settings.scenarioOverlayStatus('7').sources).toEqual({
                patch: ['exposureTarget', 'boostTime', 'autoSubmit'],
                literals: ['exposureTarget'],
                bindings: ['exposure'],
                profile: ['autoBoost', 'boostTime'],
            });
        });

        test('never writes the configuration: the overrides and the saved values are as they were', () => {
            assign(bindingPlan());
            const before = store.value;
            change({ phasePatch: { autoSubmit: true } });
            publish();
            expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(true);
            expect(store.value).toBe(before);
            expect(settings.getChallengeOverrides('7')).toEqual({ scenario: 'Plan', exposure: 40 });
            expect(settings.getEffectiveSetting('autoSubmit')).toBe(settings.getGlobalDefault('autoSubmit'));
        });

        test('makes a phase with literals only a published one: nothing is read until it is published', () => {
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { settings: { exposure: 10, exposureTarget: 12 } } },
            });
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
            change({ phasePatch: { autoSubmit: true } });
            expect(settings.scenarioSubjectAvailable('7')).toBe(false);
            expect(() => settings.getEffectiveSetting('autoSubmit', '7')).toThrow(
                settings.ScenarioSettingUnavailableError,
            );
            publish();
            expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(true);
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        });

        test('a patch changed after publishing makes the publication unavailable', () => {
            assign();
            publish();
            change({ phasePatch: { autoSubmit: true } });
            expect(settings.scenarioSubjectReason('7')).toBe(
                'the scenario or its profile changed after its settings were published',
            );
            publish();
            expect(settings.scenarioSubjectAvailable('7')).toBe(true);
            // a patch that was taken out again is a change too
            scenarioStateLedger.change('7', (current) => {
                const rest = { ...(current as ScenarioState) };
                delete rest.phasePatch;
                return rest;
            });
            expect(settings.scenarioSubjectAvailable('7')).toBe(false);
        });

        test.each([
            [
                'a key a phase may not write',
                { manualPhotosOnly: false },
                'manualPhotosOnly',
                'not a setting a phase may change',
            ],
            ['an unknown key', { nonsense: 1 }, 'nonsense', 'not a setting a phase may change'],
            ['a value its setting refuses', { autoExposureFillBelow: 5000 }, 'autoExposureFillBelow', undefined],
        ])('%s refuses the whole phase, naming the key', (_label, phasePatch, key, reason) => {
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { settings: { autoBoost: true, exposure: 10, exposureTarget: 90 } } },
            });
            change({ phasePatch });
            const { result } = prepare();
            expect(result).toMatchObject({ ok: false, key });
            if (reason !== undefined) expect(result).toMatchObject({ reason: expect.stringContaining(reason) });
        });

        test('a runtime target adjusts the lower-priority phase trigger', () => {
            settings.saveChallengeProfile('High exposure', { exposure: 90 });
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { profile: 'High exposure', settings: { exposure: 80, exposureTarget: 95 } } },
            });
            publish();
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(80);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(95);
            change({ phasePatch: { exposureTarget: 75 } });
            const { result } = prepare();
            if (!result.ok) throw new Error('phase did not prepare');
            expect(result.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 75 } });
            expect(result.snapshot.readSetting('exposureTarget', 'effective')).toMatchObject({ value: { value: 75 } });
            publish();
            expect(settings.getEffectiveSetting('exposure', '7')).toBe(75);
            expect(settings.getEffectiveSetting('exposureTarget', '7')).toBe(75);
        });

        test('owns a group of settings as the first source that sets any member: the others read 0', () => {
            settings.setGlobalDefault('autoJoinAfterHoursFromStart', 5);
            settings.setGlobalDefault('autoJoinAfterPercentElapsed', 25);
            settings.setGlobalDefault('autoJoinWithinHoursOfEnd', 8);
            assign({
                name: 'Plan',
                version: 1,
                start: 'push',
                phases: { push: { settings: { autoJoinWithinHoursOfEnd: 3 } } },
            });
            change({ phasePatch: { autoJoinAfterHoursFromStart: 2 } });
            publish();
            const timing = ['autoJoinAfterHoursFromStart', 'autoJoinAfterPercentElapsed', 'autoJoinWithinHoursOfEnd'];
            expect(timing.map((key) => settings.getEffectiveSetting(key, '7'))).toEqual([2, 0, 0]);
        });

        describe('the runtime profile', () => {
            beforeEach(() => {
                settings.saveChallengeProfile('Tactic', { autoBoost: true, boostTime: 120 });
                settings.saveChallengeProfile('Calm', { boostTime: 300 });
            });

            test('replaces the phase profile for this phase entry, and none (null) takes it away', () => {
                assign({ name: 'Plan', version: 1, start: 'push', phases: { push: { profile: 'Tactic' } } });
                publish();
                expect(settings.getEffectiveSetting('boostTime', '7')).toBe(120);
                change({ phaseProfile: 'Calm' });
                publish();
                expect(settings.getEffectiveSetting('boostTime', '7')).toBe(300);
                expect(scenarioStateLedger.get(7).state?.published?.profile).toBe('Calm');
                change({ phaseProfile: null });
                publish();
                expect(settings.scenarioOverlayStatus('7').sources.profile).toEqual([]);
                expect(settings.getEffectiveSetting('boostTime', '7')).toBe(settings.getGlobalDefault('boostTime'));
                expect(scenarioStateLedger.get(7).state?.published?.profile).toBeNull();
            });

            test('gives a phase that names none a profile, as a bound phase', () => {
                assign({ name: 'Plan', version: 1, start: 'push', phases: { push: {} } });
                change({ phaseProfile: 'tactic' });
                expect(settings.scenarioSubjectAvailable('7')).toBe(false);
                publish();
                expect(settings.getEffectiveSetting('boostTime', '7')).toBe(120);
                expect(scenarioStateLedger.get(7).state?.published?.profile).toBe('Tactic');
            });

            test('a profile changed after publishing makes the publication unavailable, and a missing one blocks the phase', () => {
                assign({ name: 'Plan', version: 1, start: 'push', phases: { push: {} } });
                change({ phaseProfile: 'Tactic' });
                publish();
                change({ phaseProfile: 'Calm' });
                expect(settings.scenarioSubjectReason('7')).toBe(
                    'the scenario or its profile changed after its settings were published',
                );
                settings.deleteChallengeProfile('Calm');
                expect(prepare().result).toEqual({ ok: false, key: null, reason: 'profile-unavailable: Calm' });
            });
        });
    });

    describe('what a saved profile must be to be a phase profile', () => {
        test('the name as saved, whatever case it is asked in', () => {
            settings.saveChallengeProfile('Tactic', { autoBoost: true });
            expect(settings.checkPhaseProfile('tACTIC')).toEqual({ ok: true, name: 'Tactic' });
        });

        test('refused with its reason: not saved, not valid, or setting a key a phase cannot change', () => {
            expect(settings.checkPhaseProfile('Nope')).toEqual({
                ok: false,
                reason: 'there is no profile named "Nope"',
            });
            settings.saveChallengeProfile('Plain', { autoBoost: true });
            const damage = (name: string, value: unknown) => {
                const blob = parseJsonAs(
                    store.value!,
                    isShape<{ profiles: Record<string, unknown> }>({ profiles: isRecordOf(isUnknown) }),
                );
                blob.profiles[name] = value;
                store.value = JSON.stringify(blob);
            };
            damage('Plain', ['bad']);
            expect(settings.checkPhaseProfile('Plain')).toEqual({
                ok: false,
                reason: 'the profile "Plain" is not valid',
            });
            damage('Plain', { manualPhotosOnly: true });
            expect(settings.checkPhaseProfile('Plain')).toEqual({
                ok: false,
                reason: 'the profile "Plain" sets manualPhotosOnly, which a phase cannot change',
            });
            damage('Plain', { scenario: 'Plan' });
            expect(settings.checkPhaseProfile('plain')).toEqual({
                ok: false,
                reason: 'the profile "Plain" sets scenario, which a phase cannot change',
            });
        });
    });
});

describe('a scenario phase with dynamic schedules', () => {
    let store: MemoryStore;

    const instant = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'instant' });
    const hours = (value: number) =>
        invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'duration', unit: 'hours' });

    const schedulePlan = (schedules: Record<string, unknown>) => ({
        name: 'Plan',
        version: 1,
        start: 'timed',
        phases: { timed: { schedules }, plain: {} },
    });
    const submitSchedule = () => ({
        submit: { alignment: 'end', rows: [{ count: 2, at: instant(5000) }] },
    });
    const resolvedSubmit = {
        submit: { alignment: 'end', rows: [{ count: 2, state: 'known', at: 5000 }] },
    };

    const assign = (doc: unknown = schedulePlan(submitSchedule())) => {
        expect(settings.saveScenario(doc)).toEqual({ ok: true, name: 'Plan' });
        settings.setChallengeOverride('scenario', '7', 'Plan');
        expect(scenarioStateLedger.set(7, initialState('Plan', 'timed', 1000))).toBe('saved');
    };

    /** What the runner does for this phase: works out the schedules and publishes them. */
    const publish = (resolved: unknown = resolvedSubmit) => {
        const scenario = settings.getScenario('Plan') as ScenarioDocument;
        const state = scenarioStateLedger.get(7).state as ScenarioState;
        const result = settings.prepareScenarioSnapshot(
            7,
            scenario,
            state,
            () => ({ bound: {}, validUntil: null, schedules: invalid(resolved) }),
            1500,
        );
        if (!result.ok || !result.snapshot.publication) throw new Error('nothing to publish');
        expect(scenarioStateLedger.set(7, { ...state, published: result.snapshot.publication })).toBe('saved');
        return result.snapshot.publication;
    };

    beforeEach(() => {
        store = installHeadlessStore();
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    test('a challenge with no scenario, or a phase with no schedules, has none to read', () => {
        expect(settings.getPhaseSchedules(7)).toEqual({ kind: 'none' });
        assign(schedulePlan(submitSchedule()));
        scenarioStateLedger.set(7, initialState('Plan', 'plain', 1000));
        expect(settings.getPhaseSchedules(7)).toEqual({ kind: 'none' });
    });

    test('a phase with schedules is read through its publication: the resolved rows, as published', () => {
        assign();
        expect(settings.getPhaseSchedules(7)).toEqual({
            kind: 'unavailable',
            reason: 'nothing is published for this phase yet',
        });
        const publication = publish();
        expect(publication.schedules).toEqual(resolvedSubmit);
        expect(settings.getPhaseSchedules(7)).toEqual({ kind: 'resolved', schedules: resolvedSubmit });
        // the phase has no literal or binding of its own, yet it is read through a publication, so it is bound
        expect(settings.scenarioOverlayStatus(7)).toMatchObject({ bound: true, available: true });
    });

    test('a phase that gets no resolved schedule from its owner publishes none and reads as none published', () => {
        assign();
        const scenario = settings.getScenario('Plan') as ScenarioDocument;
        const state = scenarioStateLedger.get(7).state as ScenarioState;
        const result = settings.prepareScenarioSnapshot(
            7,
            scenario,
            state,
            () => ({ bound: {}, validUntil: null }),
            1500,
        );
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('prepared');
        expect(result.snapshot.publication).not.toHaveProperty('schedules');
        scenarioStateLedger.set(7, { ...state, published: result.snapshot.publication as ScenarioState['published'] });
        expect(settings.getPhaseSchedules(7)).toMatchObject({ kind: 'unavailable' });
    });

    test('a publication made for other kinds of schedule than the phase holds is unavailable', () => {
        assign(schedulePlan({ ...submitSchedule(), pause: { rows: [{ at: instant(1), duration: hours(1) }] } }));
        publish({ submit: resolvedSubmit.submit, pause: { rows: [{ state: 'known', start: 1, end: 3601 }] } });
        expect(settings.getPhaseSchedules(7)).toMatchObject({ kind: 'resolved' });
        // the owner's publication names a kind the phase no longer carries
        const state = scenarioStateLedger.get(7).state as ScenarioState;
        scenarioStateLedger.set(7, {
            ...state,
            published: { ...(state.published as NonNullable<ScenarioState['published']>), schedules: resolvedSubmit },
        } as ScenarioState);
        expect(settings.getPhaseSchedules(7)).toEqual({
            kind: 'unavailable',
            reason: 'the published settings do not match the schedules of this phase',
        });
    });

    test('an edit of the schedules after they were published makes the publication unavailable until it is made again', () => {
        assign();
        publish();
        expect(
            settings.saveScenario(
                schedulePlan({ submit: { alignment: 'absolute', rows: [{ count: 2, at: instant(1) }] } }),
                {
                    expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
                },
            ),
        ).toEqual({ ok: true, name: 'Plan' });
        expect(settings.getPhaseSchedules(7)).toEqual({
            kind: 'unavailable',
            reason: 'the scenario or its profile changed after its settings were published',
        });
    });

    describe('what the progress file keeps of a publication’s schedules', () => {
        const window = { rows: [{ state: 'known', start: 1, end: 2 }] };
        const stored = (schedules: unknown) => {
            assign();
            publish();
            const blob = parseJsonAs(store.keys.get('gs_scenario_state')!, isRecordOf(isRecordOf(isUnknown)));
            const published = invalid<Record<string, unknown>>(blob['7'].published);
            published.schedules = schedules;
            store.keys.set('gs_scenario_state', JSON.stringify(blob));
            return scenarioStateLedger.get(7);
        };

        test('every kind, with known, absent and unknown rows, is read back as it was published', () => {
            const schedules = {
                submit: {
                    alignment: 'absolute',
                    rows: [
                        { count: 1, state: 'known', at: 5 },
                        { count: 2, state: 'absent', reason: 'not-present' },
                        { count: 4, state: 'unknown', reason: 'boost-timeout-malformed' },
                    ],
                },
                vote: window,
                pause: {
                    rows: [
                        { state: 'unknown', reason: 'r' },
                        { state: 'absent', reason: 'off' },
                    ],
                },
            };
            expect(stored(schedules).state?.published?.schedules).toEqual(schedules);
        });

        test.each([
            ['a list', []],
            ['a kind that is none of the three', { other: window }],
            ['a submit schedule with an alignment of its own', { submit: { alignment: 'start', rows: [] } }],
            ['a submit schedule with no rows', { submit: { alignment: 'end', rows: [] } }],
            [
                'a submit schedule with extra fields',
                { submit: { alignment: 'end', rows: [{ count: 2, state: 'known', at: 1 }], x: 1 } },
            ],
            ['a submit row of count 5', { submit: { alignment: 'end', rows: [{ count: 5, state: 'known', at: 1 }] } }],
            ['a submit row of count 0', { submit: { alignment: 'end', rows: [{ count: 0, state: 'known', at: 1 }] } }],
            [
                'a submit row of a fractional count',
                { submit: { alignment: 'end', rows: [{ count: 1.5, state: 'known', at: 1 }] } },
            ],
            [
                'five submit rows',
                {
                    submit: {
                        alignment: 'end',
                        rows: [1, 2, 3, 4, 4].map((count) => ({ count, state: 'known', at: 1 })),
                    },
                },
            ],
            ['a known row with no instant', { submit: { alignment: 'end', rows: [{ count: 2, state: 'known' }] } }],
            [
                'a known row with an extra field',
                { submit: { alignment: 'end', rows: [{ count: 2, state: 'known', at: 1, reason: 'x' }] } },
            ],
            ['an unknown row with no reason', { submit: { alignment: 'end', rows: [{ count: 2, state: 'unknown' }] } }],
            [
                'an absent row with a reason that is not text',
                { submit: { alignment: 'end', rows: [{ count: 2, state: 'absent', reason: 3 }] } },
            ],
            [
                'a reason that is far too long',
                { submit: { alignment: 'end', rows: [{ count: 2, state: 'absent', reason: 'x'.repeat(500) }] } },
            ],
            ['a state of its own', { submit: { alignment: 'end', rows: [{ count: 2, state: 'maybe', reason: 'x' }] } }],
            ['a row that is not an object', { submit: { alignment: 'end', rows: ['x'] } }],
            ['a vote schedule that is not an object', { vote: 3 }],
            ['a vote schedule with extra fields', { vote: { ...window, x: 1 } }],
            ['a vote schedule with no rows', { vote: { rows: [] } }],
            ['seven pause rows', { pause: { rows: Array.from({ length: 7 }, () => window.rows[0]) } }],
            ['a window whose end is not a number', { pause: { rows: [{ state: 'known', start: 1, end: 'x' }] } }],
            ['a window with no start', { pause: { rows: [{ state: 'known', end: 2 }] } }],
        ])('%s makes the publication unreadable, not the whole record', (_label, schedules) => {
            const read = stored(schedules);
            expect(read.corrupt).toBe(false);
            expect(read.state).toMatchObject({ phase: 'timed', publicationUnreadable: true });
            expect(read.state?.published).toBeUndefined();
        });
    });

    test('progress that cannot be read makes the schedules unavailable, never the literal settings', () => {
        assign();
        publish();
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.getPhaseSchedules(7)).toEqual({
            kind: 'unavailable',
            reason: 'the saved progress of this challenge cannot be read',
        });
    });
});
