/**
 * The installation scenario and its owner: the explicit selection with a generation, the fence that makes a former
 * owner fail its next write, the explicit transfer that never happens by itself, the scope of the documents, the
 * reserved ledger subjects, and a paused subject that runs nothing and keeps its progress.
 */

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
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
    };
});
jest.mock('../../src/ts/core/services/currencyActions', () => ({
    withSpendLock: jest.fn(async (spend: () => Promise<unknown>) => ({ busy: false, value: await spend() })),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    unlockBoostWithKey: jest.fn(),
    fillExposure: jest.fn(),
}));
jest.mock('../../src/ts/core/services/autoFill', () => ({
    submitNewEntryForAction: jest.fn(),
    refreshChallengeState: jest.fn(async () => 'refreshed'),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
    getSlotsRemaining: jest.fn(),
}));

import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import loggerModule = require('../../src/ts/core/logger');
const logger = jest.mocked(loggerModule);
import currencyActionsModule = require('../../src/ts/core/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as runnerModule from '../../src/ts/core/services/scenarioRunner';
import type { ConfigV2, InstallationExecutor } from '../../src/ts/core/types/config';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import { isConfig } from '../helpers/storedShapes';
import { parseJsonAs, parseJsonObject } from '../helpers/parseJson';
import { invalid } from '../helpers/invalid';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';

const { scenarioStateLedger, initialState, INSTALLATION_KEY } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { runScenarioStep } = require('../../src/ts/core/services/scenarioRunner') as typeof runnerModule;

const STATE_KEY = 'gs_scenario_state';
const NOW = Math.floor(Date.now() / 1000);

const challengePlan = (name = 'Plan') => ({
    name,
    version: 1,
    start: 'main',
    phases: {
        main: { rules: [{ id: 'fill', do: [{ type: 'fillExposure' }, { type: 'notify', message: 'filled' }] }] },
    },
});
const installationPlan = (name: string) => ({
    name,
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: { main: { settings: { autoClaimPrizes: true } }, later: {} },
});

let store: MemoryStore;
const blob = (): ConfigV2 => parseJsonAs(store.value!, isConfig);
const record = (key: string): ScenarioState | null => scenarioStateLedger.get(key).state;
const seed = (key: string, patch: Partial<ScenarioState> = {}, scenario = 'Plan') => {
    expect(scenarioStateLedger.change(key, () => ({ ...initialState(scenario, 'main', NOW), ...patch })).ok).toBe(true);
};
const select = (name: string | null, executor: InstallationExecutor, generation: number) =>
    settings.setInstallationScenario(name, executor, generation);

const challenge = () =>
    invalid<Challenge>({
        id: 7,
        start_time: NOW - 86400,
        close_time: NOW + 5 * 86400,
        max_photo_submits: 4,
        member: {
            boost: { state: 'AVAILABLE' },
            turbo: { state: 'WON', mode: 'classic' },
            ranking: {
                entries: [{ id: 'a', votes: 10, rank: 20, member_id: 'm' }],
                exposure: { exposure_factor: 30 },
                swaps: [],
            },
        },
    });
const runStep = async () =>
    runScenarioStep(
        challenge(),
        NOW,
        invalid({
            token: 'tok',
            api: {},
            fillDeps: {},
            currency: { strategy: { getBankroll: jest.fn(async () => ({ keys: 5, swaps: 5, fills: 5, coins: 0 })) } },
            scenarios: { ledger: scenarioStateLedger },
        }),
    );

beforeEach(async () => {
    jest.clearAllMocks();
    store = installHeadlessStore();
    // The stores keep what they last read: a store of the last test is not this one's.
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
    settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
    settings.rememberChallengeTitles([]);
});

describe('selecting the installation scenario', () => {
    test('one scenario and one owner, explicitly; the generation starts at 0 and advances with every change', () => {
        expect(settings.getInstallationScenario()).toBeNull();
        expect(settings.installationGeneration()).toBe(0);
        expect(settings.saveScenario(installationPlan('Whole')).ok).toBe(true);
        expect(select('Whole', 'electron', 0)).toEqual({
            ok: true,
            installation: { scenario: 'Whole', executor: 'electron', generation: 1 },
            generation: 1,
        });
        expect(blob().installationScenario).toEqual({ scenario: 'Whole', executor: 'electron', generation: 1 });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Whole', phase: 'main', generation: 1 });
        expect(settings.installationGeneration()).toBe(1);
    });

    test('a stale generation is refused, with the current one, and nothing changes', () => {
        settings.saveScenario(installationPlan('Whole'));
        select('Whole', 'electron', 0);
        const before = store.value;
        const ledgerBefore = store.keys.get(STATE_KEY);
        expect(select('Whole', 'cli', 0)).toEqual({ ok: false, reason: 'stale-generation', generation: 1 });
        expect(select(null, 'cli', 9)).toEqual({ ok: false, reason: 'stale-generation', generation: 1 });
        expect(store.value).toBe(before);
        expect(store.keys.get(STATE_KEY)).toBe(ledgerBefore);
    });

    test('a document for challenges, a missing one and an unknown executor are refused', () => {
        settings.saveScenario(challengePlan('Plan'));
        expect(select('Plan', 'electron', 0)).toEqual({ ok: false, reason: 'incompatible-scope', generation: 0 });
        expect(select('Nothing', 'electron', 0)).toEqual({ ok: false, reason: 'unknown-scenario', generation: 0 });
        expect(select('Plan', invalid<InstallationExecutor>('browser'), 0)).toEqual({
            ok: false,
            reason: 'invalid-executor',
        });
        expect(settings.transferInstallationOwner(invalid<InstallationExecutor>('browser'), 0)).toEqual({
            ok: false,
            reason: 'invalid-executor',
        });
        expect(settings.getInstallationScenario()).toBeNull();
        expect(record(INSTALLATION_KEY)).toBeNull();
    });

    test('every executor may own it, and a challenge scenario cannot take the installation key', () => {
        settings.saveScenario(installationPlan('Whole'));
        let generation = 0;
        for (const executor of ['electron', 'cli', 'web', 'android-service', 'android-app'] as const) {
            expect(select('Whole', executor, generation)).toMatchObject({ ok: true, generation: generation + 1 });
            generation += 1;
        }
        expect(settings.getInstallationScenario()?.executor).toBe('android-app');
    });

    test('clearing keeps the count in the installation record, so a former owner stays fenced', () => {
        settings.saveScenario(installationPlan('Whole'));
        select('Whole', 'electron', 0);
        expect(select(null, 'electron', 1)).toEqual({ ok: true, installation: null, generation: 2 });
        expect(settings.getInstallationScenario()).toBeNull();
        expect(blob().installationScenario).toBeUndefined();
        expect(record(INSTALLATION_KEY)?.generation).toBe(2);
        expect(settings.installationGeneration()).toBe(2);
        // The next selection continues the count instead of starting over.
        expect(select('Whole', 'cli', 1)).toMatchObject({ ok: false, reason: 'stale-generation', generation: 2 });
        expect(select('Whole', 'cli', 2)).toMatchObject({ ok: true, generation: 3 });
    });

    test('clearing with nothing ever selected still advances the count, from a record of its own', () => {
        expect(select(null, 'electron', 0)).toEqual({ ok: true, installation: null, generation: 1 });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: '', generation: 1 });
    });

    test('the same scenario selected again keeps its progress; another one starts at its start phase', () => {
        settings.saveScenario(installationPlan('Whole'));
        settings.saveScenario(installationPlan('Other'));
        select('Whole', 'electron', 0);
        seed(INSTALLATION_KEY, { memory: { held: 'z' }, generation: 1, phase: 'later' }, 'Whole');
        select(null, 'electron', 1);
        expect(select('whole', 'electron', 2)).toMatchObject({ ok: true });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Whole', phase: 'later', memory: { held: 'z' } });
        expect(select('Other', 'electron', 3)).toMatchObject({ ok: true });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Other', phase: 'main', memory: {} });
    });

    test('a selection is held by unresolved work of the installation, and by unreadable progress', () => {
        settings.saveScenario(installationPlan('Whole'));
        settings.saveScenario(installationPlan('Other'));
        select('Whole', 'electron', 0);
        seed(
            INSTALLATION_KEY,
            { generation: 1, inFlight: { ruleId: 'r', actionIndex: 0, pending: 'fillExposure' } },
            'Whole',
        );
        const before = store.keys.get(STATE_KEY);
        expect(select('Other', 'electron', 1)).toEqual({ ok: false, reason: 'unresolved-work' });
        expect(select(null, 'electron', 1)).toEqual({ ok: false, reason: 'unresolved-work' });
        expect(store.keys.get(STATE_KEY)).toBe(before);
        store.keys.set(STATE_KEY, '{broken');
        expect(select('Other', 'electron', 1)).toEqual({ ok: false, reason: 'state-unreadable' });
        expect(settings.installationGeneration()).toBeNull();
        expect(settings.transferInstallationOwner('cli', 1)).toEqual({ ok: false, reason: 'state-unreadable' });
    });

    test('a record the ledger cannot write leaves the selection as it was; one the configuration cannot save leaves the fence moved', () => {
        settings.saveScenario(installationPlan('Whole'));
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(select('Whole', 'electron', 0)).toEqual({ ok: false, reason: 'not-saved', generation: 0 });
        store.writeKey = real;
        expect(settings.getInstallationScenario()).toBeNull();

        store.write.mockReturnValueOnce(false);
        expect(select('Whole', 'electron', 0)).toEqual({ ok: false, reason: 'not-saved', generation: 1 });
        // The fence moved first: whoever owned it is already fenced, and the generation the caller must retry on is 1.
        expect(record(INSTALLATION_KEY)?.generation).toBe(1);
        expect(settings.getInstallationScenario()).toBeNull();
        expect(settings.installationGeneration()).toBe(1);
        expect(select('Whole', 'electron', 1)).toMatchObject({ ok: true, generation: 2 });
    });

    test('a malformed assignment is dropped by a load, once, and leaves none', () => {
        settings.saveScenario(installationPlan('Whole'));
        select('Whole', 'electron', 0);
        const warned = () => logger.withCategory('settings').warning;
        // Said when it first happens, not on every read after it (the same notice for the same drop).
        const dropNotices = () =>
            jest.mocked(warned()).mock.calls.filter(([text]) => String(text).includes('installationScenario'));
        for (const bad of [
            { scenario: 'Whole', executor: 'browser', generation: 1 },
            { scenario: 'Whole', executor: 'cli', generation: -1 },
            { scenario: 'Whole', executor: 'cli', generation: 1.5 },
            { scenario: '', executor: 'cli', generation: 1 },
            { scenario: 'Whole', executor: 'cli', generation: 1, extra: true },
            { scenario: 'Whole', executor: 'cli' },
            'Whole',
            null,
        ]) {
            const raw = blob();
            Object.assign(raw, { installationScenario: bad });
            store.value = JSON.stringify(raw);
            expect(settings.loadSettings().installationScenario).toBeUndefined();
            expect(settings.getInstallationScenario()).toBeNull();
        }
        expect(dropNotices()).toHaveLength(1);
    });
});

describe('the owner and the fence', () => {
    beforeEach(() => {
        settings.saveScenario(installationPlan('Whole'));
        select('Whole', 'electron', 0);
    });

    test('a transfer is explicit: the progress is kept, the generation advances, the owner changes', () => {
        seed(
            INSTALLATION_KEY,
            { generation: 1, memory: { held: 'z' }, inFlight: { ruleId: 'r', actionIndex: 1 } },
            'Whole',
        );
        expect(settings.transferInstallationOwner('cli', 1)).toEqual({
            ok: true,
            installation: { scenario: 'Whole', executor: 'cli', generation: 2 },
            generation: 2,
        });
        // Unresolved work is the next owner's to reconcile: a transfer keeps it as it is.
        expect(record(INSTALLATION_KEY)).toMatchObject({
            scenario: 'Whole',
            generation: 2,
            memory: { held: 'z' },
            inFlight: { ruleId: 'r', actionIndex: 1 },
        });
        expect(settings.getInstallationScenario()).toEqual({ scenario: 'Whole', executor: 'cli', generation: 2 });
    });

    test('the former owner fails its next write, and the new owner does not', () => {
        const former = scenarioStateLedger.get(INSTALLATION_KEY);
        expect(former.state).toMatchObject({ generation: 1 });
        expect(settings.transferInstallationOwner('cli', 1).ok).toBe(true);
        const before = store.keys.get(STATE_KEY);
        expect(scenarioStateLedger.set(INSTALLATION_KEY, { ...former.state!, memory: { late: 'write' } })).toBe(
            'stale',
        );
        expect(store.keys.get(STATE_KEY)).toBe(before);
        // A state made without the generation (a fresh start) is as stale.
        expect(scenarioStateLedger.set(INSTALLATION_KEY, initialState('Whole', 'main', NOW))).toBe('stale');
        // The owner reads again, under the generation that now stands, and writes.
        const current = scenarioStateLedger.get(INSTALLATION_KEY).state!;
        expect(scenarioStateLedger.set(INSTALLATION_KEY, { ...current, memory: { fresh: 'write' } })).toBe('saved');
        expect(record(INSTALLATION_KEY)?.memory).toEqual({ fresh: 'write' });
    });

    test('there is no automatic takeover: nothing but an explicit call moves the owner or the generation', async () => {
        const before = JSON.stringify([blob().installationScenario, record(INSTALLATION_KEY)?.generation]);
        // Passes, reads, refreshes and a former owner trying to take it back change nothing.
        settings.saveScenario(challengePlan('Plan'));
        settings.setChallengeOverride('scenario', '7', 'Plan');
        await runStep();
        await runStep();
        settings.loadSettings();
        expect(settings.transferInstallationOwner('electron', 0)).toEqual({
            ok: false,
            reason: 'stale-generation',
            generation: 1,
        });
        expect(select('Whole', 'electron', 0)).toMatchObject({ ok: false, reason: 'stale-generation' });
        expect(JSON.stringify([blob().installationScenario, record(INSTALLATION_KEY)?.generation])).toBe(before);
        expect(settings.getInstallationScenario()?.executor).toBe('electron');
    });

    test('a transfer needs an assignment, a current generation, readable progress and a free step lock', () => {
        expect(settings.transferInstallationOwner('web', 5)).toEqual({
            ok: false,
            reason: 'stale-generation',
            generation: 1,
        });
        select(null, 'electron', 1);
        expect(settings.transferInstallationOwner('web', 2)).toEqual({ ok: false, reason: 'no-installation' });
    });

    test('a transfer whose record cannot be written, or whose configuration cannot be saved, says so', () => {
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(settings.transferInstallationOwner('cli', 1)).toEqual({ ok: false, reason: 'not-saved', generation: 1 });
        store.writeKey = real;
        expect(settings.getInstallationScenario()?.executor).toBe('electron');
        store.write.mockReturnValueOnce(false);
        expect(settings.transferInstallationOwner('cli', 1)).toEqual({ ok: false, reason: 'not-saved', generation: 2 });
        expect(settings.installationGeneration()).toBe(2);
        expect(settings.transferInstallationOwner('cli', 2)).toMatchObject({ ok: true, generation: 3 });
    });

    test('an installation scenario whose document is gone is still handed over, keeping its record', () => {
        const raw = blob();
        raw.scenarios = {};
        store.value = JSON.stringify(raw);
        expect(settings.transferInstallationOwner('web', 1)).toMatchObject({ ok: true, generation: 2 });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Whole', generation: 2 });
    });
});

describe('the reserved subjects of the ledger', () => {
    test('`@installation` is a subject; `@all` and any other `@` key are not, whatever is asked of them', async () => {
        expect(scenarioStateLedger.set(INSTALLATION_KEY, initialState('Whole', 'main', NOW))).toBe('saved');
        for (const key of ['@all', '@other', '@']) {
            expect(scenarioStateLedger.set(key, initialState('Plan', 'main', NOW))).toBe('refused');
            expect(scenarioStateLedger.get(key)).toMatchObject({ corrupt: 'record', state: null });
            expect(scenarioStateLedger.change(key, () => initialState('Plan', 'main', NOW))).toEqual({
                ok: false,
                reason: 'reserved-subject',
            });
            await expect(scenarioStateLedger.remove(key)).resolves.toBe('unreadable');
        }
        expect(scenarioStateLedger.list().subjects.map(({ key }) => key)).toEqual([INSTALLATION_KEY]);
    });

    test('the installation record is never aged out, a handoff intent is never pruned, a challenge record ages as before', () => {
        const old = { updatedAt: Date.now() - 40 * 24 * 3600 * 1000 };
        const aged = (key: string, patch: Partial<ScenarioState>) => ({
            ...initialState('Plan', 'main', NOW),
            ...patch,
            ...old,
        });
        store.keys.set(
            STATE_KEY,
            JSON.stringify({
                [INSTALLATION_KEY]: aged(INSTALLATION_KEY, { generation: 4 }),
                '1': aged('1', {}),
                '2': aged('2', { handoff: { from: 'Plan', to: null, generation: 0, at: NOW } }),
            }),
        );
        // Any write prunes what is old and holds nothing.
        seed('3');
        expect(Object.keys(parseJsonObject(store.keys.get(STATE_KEY)!)).sort()).toEqual(['2', '3', INSTALLATION_KEY]);
    });

    test('a record with a malformed lifecycle field is unreadable, not read as having none', () => {
        const base = initialState('Plan', 'main', NOW);
        for (const bad of [
            { generation: -1 },
            { generation: 'x' },
            { paused: { at: 1 } },
            { paused: { at: 'x', reason: 'r' } },
            { paused: { at: 1, reason: 'r', extra: 1 } },
            { handoff: { from: 'a', to: 5, generation: 0, at: 1 } },
            { handoff: { from: 'a', to: null, generation: 1.5, at: 1 } },
            { handoff: { from: 'a', to: null, generation: 0 } },
            { lastRequest: { id: 'a', result: 'b' } },
            { lastRequest: { id: 1, result: 'b', at: 1 } },
        ]) {
            store.keys.set(STATE_KEY, JSON.stringify({ '7': { ...base, ...bad } }));
            expect(scenarioStateLedger.get('7')).toMatchObject({ corrupt: 'record', state: null });
            expect(scenarioStateLedger.list().subjects[0].state).toBeNull();
        }
        for (const good of [
            { paused: null },
            { paused: { at: 1, reason: 'asked' } },
            { handoff: null },
            { lastRequest: null },
            { lastRequest: { id: 'a', result: 'ok', at: 1 } },
        ]) {
            store.keys.set(STATE_KEY, JSON.stringify({ '7': { ...base, ...good } }));
            expect(scenarioStateLedger.get('7').corrupt).toBe(false);
        }
    });

    test('a record change reads, decides and writes in one step; a tombstone and a missing record read as none', () => {
        const seen: Array<ScenarioState | null> = [];
        const written = scenarioStateLedger.change('7', (current) => {
            seen.push(current);
            return initialState('Plan', 'main', NOW);
        });
        expect(written).toMatchObject({ ok: true, state: { scenario: 'Plan' } });
        expect(
            scenarioStateLedger.change('7', (current) => {
                seen.push(current);
                return { refuse: 'no thanks' };
            }),
        ).toEqual({ ok: false, reason: 'no thanks' });
        expect(seen[0]).toBeNull();
        expect(seen[1]).toMatchObject({ scenario: 'Plan' });
        store.keys.set(STATE_KEY, JSON.stringify({ '7': { tombstone: true, gen: 2, updatedAt: Date.now() } }));
        expect(
            scenarioStateLedger.change('7', (current) => (current ? { refuse: 'x' } : initialState('A', 'main', 1))),
        ).toMatchObject({
            ok: true,
        });
        store.keys.set(STATE_KEY, JSON.stringify({ '7': { scenario: 5 } }));
        expect(scenarioStateLedger.change('7', () => initialState('A', 'main', 1))).toEqual({
            ok: false,
            reason: 'state-unreadable',
        });
        store.keys.set(STATE_KEY, '{broken');
        expect(scenarioStateLedger.change('7', () => initialState('A', 'main', 1))).toEqual({
            ok: false,
            reason: 'state-unreadable',
        });
        expect(scenarioStateLedger.list()).toEqual({ corrupt: 'file', subjects: [] });
    });

    test('a record that is written by a reset is not undone by a change, and a malformed publication is dropped', () => {
        seed('7', {
            published: invalid({ revision: 'x' }),
        });
        expect(scenarioStateLedger.get('7').state?.publicationUnreadable).toBe(true);
        const changed = scenarioStateLedger.change('7', (current) =>
            current ? { ...current, memory: { a: 'b' } } : { refuse: 'none' },
        );
        expect(changed).toMatchObject({ ok: true, state: { memory: { a: 'b' } } });
        expect(parseJsonObject(store.keys.get(STATE_KEY)!)['7']).not.toHaveProperty('published');
    });

    test('a change whose write throws is not saved', () => {
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(scenarioStateLedger.change('7', () => initialState('A', 'main', 1))).toEqual({
            ok: false,
            reason: 'not-saved',
        });
        store.writeKey = real;
    });
});

describe('a paused subject', () => {
    const arrange = () => {
        settings.saveScenario(challengePlan('Plan'));
        settings.setChallengeOverride('scenario', '7', 'Plan');
        seed('7', { memory: { held: 'z' }, fired: { earlier: { at: 3 } }, spent: { swaps: 1, keys: 0, fills: 2 } });
    };

    test('runs no action, records nothing, and keeps its whole progress; resuming continues from it', async () => {
        arrange();
        scenarioStateLedger.change('7', (current) =>
            current ? { ...current, paused: { at: NOW, reason: 'asked' } } : { refuse: 'none' },
        );
        const before = store.keys.get(STATE_KEY);
        await runStep();
        await runStep();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(store.keys.get(STATE_KEY)).toBe(before);
        expect(record('7')).toMatchObject({
            memory: { held: 'z' },
            fired: { earlier: { at: 3 } },
            spent: { swaps: 1, keys: 0, fills: 2 },
            paused: { reason: 'asked' },
        });
        scenarioStateLedger.change('7', (current) => (current ? { ...current, paused: null } : { refuse: 'none' }));
        await runStep();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(record('7')).toMatchObject({
            memory: { held: 'z' },
            fired: { earlier: { at: 3 }, fill: expect.any(Object) },
        });
    });

    test('the pause does not hide its publication: the one that stands stays', async () => {
        arrange();
        const publication = {
            revision: 3,
            documentFingerprint: 'abc',
            phase: 'main',
            phaseEnteredAt: NOW,
            observedAt: NOW,
            validUntil: null,
            bindings: {},
            profile: null,
        };
        scenarioStateLedger.change('7', (current) =>
            current ? { ...current, paused: { at: NOW, reason: 'asked' }, published: publication } : { refuse: 'none' },
        );
        await runStep();
        expect(record('7')?.published).toEqual(publication);
    });
});
