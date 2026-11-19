/**
 * Scenario pins and photo pools: a phase's temporary Boost / Turbo pins (runtime pin, phase pin, saved pin — one resolver,
 * the saved pins never written) and the account's named photo pools, which a phase draws from with what it has given out
 * kept per subject and phase in the scenario ledger (consumed once, reserved while a submit or swap has no answer, never
 * replayed after a re-entry or a reorder, never widened into unrestricted picking).
 *
 * The settings facade, the progress ledger and the submit/swap wrapper run for real over an in-memory store; only the
 * photo endpoints are stubs.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/core/settings');
import loggerModule = require('../../src/ts/core/logger');
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as entryTimesModule from '../../src/ts/core/services/entryTimes';
import type * as entryAgeStoreModule from '../../src/ts/core/entryAgeStore';
import type * as autoFillModule from '../../src/ts/core/services/autoFill';
import type * as runtimeModule from '../../src/ts/core/scenarios/runtime';
import type * as vocabularyModule from '../../src/ts/core/scenarios/vocabulary';
import type * as entryPinsModule from '../../src/ts/core/settings/entryPins';
import type * as scenarioOverlayModule from '../../src/ts/core/settings/scenarioOverlay';
import type { ActionResult, Challenge } from '../../src/ts/core/types/gurushots';
import type { FillDeps } from '../../src/ts/core/types/autoFill';
import type { PickerPhoto } from '../../src/ts/core/types/photoPicker';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import { buildChallenge } from '../helpers/challengeFixtures';
import { isRecordOf, isShape, isUnknown, parseJsonAs } from '../helpers/parseJson';
import { isConfig } from '../helpers/storedShapes';
import { parseJsonObject } from '../helpers/parseJson';
import { invalid } from '../helpers/invalid';

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
        challengeTag: jest.fn((c: { id?: string | number } | string | number) =>
            typeof c === 'object' ? `[${c.id}]` : `[${c}]`,
        ),
    };
});
jest.mock('../../src/ts/core/services/semantic/lexicon', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/semantic/lexicon')>(
        '../../src/ts/core/services/semantic/lexicon',
    ),
}));

const { scenarioStateLedger, mockScenarioStateLedger, initialState } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { withEntryTimes } = require('../../src/ts/core/services/entryTimes') as typeof entryTimesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/core/entryAgeStore') as typeof entryAgeStoreModule;
const { submitNewEntryForAction } = require('../../src/ts/core/services/autoFill') as typeof autoFillModule;
const runtime = require('../../src/ts/core/scenarios/runtime') as typeof runtimeModule;
const vocabulary = require('../../src/ts/core/scenarios/vocabulary') as typeof vocabularyModule;
const { mergeEntryPins } = require('../../src/ts/core/settings/entryPins') as typeof entryPinsModule;
const { recordPoolEvents, readPhotoPool, reconcilePoolProgress } =
    require('../../src/ts/core/settings/scenarioOverlay') as typeof scenarioOverlayModule;
const { performJoin, inFlight } =
    require('../../src/ts/core/services/joinChallenges') as typeof import('../../src/ts/core/services/joinChallenges');
const { forgetChosenPhotosMemory } =
    require('../../src/ts/core/services/autoFill/chosenPhotos') as typeof import('../../src/ts/core/services/autoFill/chosenPhotos');

const isScenarioText = isShape<{ phases: Record<string, { photoPool: unknown }> }>({
    phases: isRecordOf(isShape<{ photoPool: unknown }>({ photoPool: isUnknown })),
});

const POOL_PLAN = {
    name: 'Queue',
    version: 1,
    start: 'feed',
    phases: { feed: { photoPool: { name: 'Wall', only: true, inOrder: true } }, rest: {} },
};

const PIN_PLAN = {
    name: 'Pins',
    version: 1,
    start: 'main',
    phases: { main: { pins: { boost: 'phaseBoost' } }, quiet: { pins: { boost: null, turbo: null } }, other: {} },
};

const logger = jest.mocked(loggerModule);
let store: MemoryStore;

const state = (): ScenarioState => scenarioStateLedger.get(7).state as ScenarioState;
const progress = () => state().poolProgress?.feed;
const view = () => settings.getChosenPoolView(7);

/** Challenge 7 in the `feed` phase of the pool plan, with the pool `Wall` saved. */
const arrangePool = (pool: string[] | null = ['p1', 'p2', 'p3'], plan: object = POOL_PLAN) => {
    expect(settings.saveScenario(plan)).toMatchObject({ ok: true });
    settings.setChallengeOverride('scenario', '7', 'Queue');
    if (pool) expect(settings.setPhotoPool('Wall', pool)).toBe('ok');
    expect(scenarioStateLedger.set(7, initialState('Queue', 'feed', 1000))).toBe('saved');
};

const enterPhase = (phase: string, extra: Partial<ScenarioState> = {}) =>
    expect(scenarioStateLedger.set(7, { ...initialState('Queue', phase, 1000), ...extra })).toBe('saved');

beforeEach(() => {
    store = installHeadlessStore();
    settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
    forgetChosenPhotosMemory();
});

afterEach(() => {
    removeHeadlessStore();
    settings.rememberChallengeTitles([]);
});

describe('a phase draws its photos from a named pool', () => {
    test('the pool stands in for the Chosen Photos settings while the phase runs, and only then', () => {
        arrangePool();
        expect(settings.getEffectiveSetting('chosenPhotos', 7)).toEqual(['p1', 'p2', 'p3']);
        expect(settings.getEffectiveSetting('chosenPhotosOnly', 7)).toBe(true);
        expect(settings.getEffectiveSetting('chosenPhotosInOrder', 7)).toBe(true);
        expect(view()).toEqual({ name: 'Wall', only: true, inOrder: true, ids: ['p1', 'p2', 'p3'], block: null });
        enterPhase('rest');
        expect(settings.getEffectiveSetting('chosenPhotos', 7)).toEqual([]);
        expect(settings.getEffectiveSetting('chosenPhotosOnly', 7)).toBe(false);
        expect(view()).toBeNull();
    });

    test('a runtime patch of a Chosen Photos setting is above the pool', () => {
        arrangePool();
        const layer = (patch: Record<string, unknown>) =>
            invalid<Parameters<typeof readPhotoPool>[1]>({
                phaseName: 'feed',
                phase: POOL_PLAN.phases.feed,
                state: { ...initialState('Queue', 'feed', 1000), phasePatch: patch },
            });
        const loaded = settings.loadSettings();
        expect(readPhotoPool(loaded, layer({}), 'chosenPhotosOnly')).toEqual({ value: true });
        expect(readPhotoPool(loaded, layer({ chosenPhotosOnly: false }), 'chosenPhotosOnly')).toBeNull();
        // The patch is per key: the pool still answers for the keys it does not set, and never for another setting.
        expect(readPhotoPool(loaded, layer({ chosenPhotosOnly: false }), 'chosenPhotos')).toEqual({
            value: ['p1', 'p2', 'p3'],
        });
        expect(readPhotoPool(loaded, layer({}), 'exposure')).toBeNull();
    });

    test('a pool without only / inOrder is neither', () => {
        arrangePool(['p1'], { ...POOL_PLAN, phases: { feed: { photoPool: { name: 'Wall' } }, rest: {} } });
        expect(view()).toEqual({ name: 'Wall', only: false, inOrder: false, ids: ['p1'], block: null });
        expect(settings.getChosenPoolView(7)?.block ?? null).toBeNull();
    });

    test('a challenge outside any pool phase has no pool and no block', () => {
        expect(view()).toBeNull();
        expect(settings.getChosenPoolView(7)?.block ?? null).toBeNull();
        expect(settings.getChosenPoolView('other')?.block ?? null).toBeNull();
    });

    test('progress that cannot be read makes the challenge unavailable instead of unrestricted', () => {
        arrangePool();
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.scenarioSubjectAvailable(7)).toBe(false);
        expect(() => settings.getEffectiveSetting('chosenPhotos', 7)).toThrow(/cannot be read/);
    });

    test('so does progress that cannot be read for a phase with pins', () => {
        expect(settings.saveScenario(PIN_PLAN)).toMatchObject({ ok: true });
        settings.setChallengeOverride('scenario', '7', 'Pins');
        store.keys.set('gs_scenario_state', '{broken');
        expect(settings.scenarioSubjectAvailable(7)).toBe(false);
    });
});

describe('what a phase has given out is the ledger’s, kept per subject and phase', () => {
    const submitted = (result: ActionResult) =>
        withEntryTimes(
            {
                submitToChallenge: jest.fn(async () => result),
                swapPhoto: jest.fn(async () => result),
            },
            createMemoryEntryAgeLedger(),
        );
    const ok: ActionResult = { ok: true, raw: { success: true } };

    test('a confirmed submit consumes its photo once; the pool definition stays as saved', async () => {
        arrangePool();
        await submitted(ok).submitToChallenge(7, ['p1'], 'tok');
        await submitted(ok).submitToChallenge(7, ['p1'], 'tok');
        const phaseReentry = { queue: progress() };
        expect(phaseReentry.queue?.consumed).toContain('p1');
        expect(phaseReentry.queue).toEqual({ consumed: ['p1'], reserved: [] });
        expect(view()?.ids).toEqual(['p2', 'p3']);
        expect(settings.getPhotoPools()).toEqual({ Wall: ['p1', 'p2', 'p3'] });
    });

    test('a confirmed swap consumes the photo swapped in', async () => {
        arrangePool();
        await submitted(ok).swapPhoto(7, 'old', 'p2', 'tok');
        expect(progress()).toEqual({ consumed: ['p2'], reserved: [] });
    });

    test('a photo that is not in the pool is not recorded, and nothing is written for it', async () => {
        arrangePool();
        const before = store.keys.get('gs_scenario_state');
        await submitted(ok).submitToChallenge(7, ['elsewhere'], 'tok');
        expect(store.keys.get('gs_scenario_state')).toBe(before);
    });

    test('re-entering the phase resumes from the same progress', async () => {
        arrangePool();
        await submitted(ok).submitToChallenge(7, ['p1'], 'tok');
        const { poolProgress } = state();
        enterPhase('rest', { poolProgress });
        expect(view()).toBeNull();
        enterPhase('feed', { poolProgress });
        expect(view()?.ids).toEqual(['p2', 'p3']);
    });

    test('a photo removed from the challenge and added again, or reordered in the pool, is never offered again', async () => {
        arrangePool();
        await submitted(ok).submitToChallenge(7, ['p1'], 'tok');
        const removedThenReaddedPhotoId = 'p1';
        // The photo leaves the challenge (a fresh read without it) and the pool is saved again in another order.
        expect(settings.reconcilePhotoPool(7, [])).toBe(false);
        expect(settings.setPhotoPool('Wall', ['p3', 'p1', 'p2'])).toBe('ok');
        const candidateIds = view()?.ids;
        expect(candidateIds).not.toContain(removedThenReaddedPhotoId);
        expect(candidateIds).toEqual(['p3', 'p2']);
        expect(progress()?.consumed).toEqual(['p1']);
    });

    test('a photo that went in some other way is consumed by the next read of the challenge', () => {
        arrangePool();
        expect(settings.reconcilePhotoPool(7, ['p2', 'unrelated'])).toBe(true);
        expect(progress()).toEqual({ consumed: ['p2'], reserved: [] });
        // Settled: the same read changes nothing, and writes nothing.
        const written = store.keys.get('gs_scenario_state');
        expect(settings.reconcilePhotoPool(7, ['p2', 'unrelated'])).toBe(false);
        expect(store.keys.get('gs_scenario_state')).toBe(written);
    });

    test('an explicit reset starts new progress', async () => {
        arrangePool();
        await submitted(ok).submitToChallenge(7, ['p1', 'p2'], 'tok');
        expect(view()?.ids).toEqual(['p3']);
        await scenarioStateLedger.remove(7);
        enterPhase('feed');
        expect(view()?.ids).toEqual(['p1', 'p2', 'p3']);
        expect(state().poolProgress).toBeUndefined();
    });

    test('mock mode records into the mock ledger only', async () => {
        arrangePool();
        settings.setSetting('mock', true);
        expect(mockScenarioStateLedger.set(7, initialState('Queue', 'feed', 1000))).toBe('saved');
        const real = store.keys.get('gs_scenario_state');
        await submitted(ok).submitToChallenge(7, ['p1'], 'tok');
        expect(mockScenarioStateLedger.get(7).state?.poolProgress?.feed.consumed).toEqual(['p1']);
        expect(store.keys.get('gs_scenario_state')).toBe(real);
        await mockScenarioStateLedger.remove(7);
    });

    test('a challenge without a pool phase writes nothing, and a user without scenarios never opens the ledger', async () => {
        const wrapped = submitted(ok);
        await wrapped.submitToChallenge(7, ['p1'], 'tok');
        arrangePool();
        enterPhase('rest');
        const before = store.keys.get('gs_scenario_state');
        await wrapped.submitToChallenge(7, ['p1'], 'tok');
        expect(store.keys.get('gs_scenario_state')).toBe(before);
        expect(settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] })).toBe(false);
        expect(settings.reconcilePhotoPool(7, ['p1'])).toBe(false);
    });

    test('with no progress record or no pool the recorder refuses', () => {
        arrangePool();
        expect(recordPoolEvents(settings.loadSettings(), '8', { consume: ['p1'], reserve: [] })).toBe(false);
        expect(recordPoolEvents(settings.loadSettings(), '7', { consume: ['p1'], reserve: [] })).toBe(true);
        enterPhase('rest');
        expect(recordPoolEvents(settings.loadSettings(), '7', { consume: ['p2'], reserve: [] })).toBe(false);
        expect(settings.reconcilePhotoPool(8, ['p1'])).toBe(false);
    });
});

describe('a submit or swap with no answer reserves its photo until the next read settles it', () => {
    const wrap = (submit: () => Promise<ActionResult>, swap: () => Promise<ActionResult> = submit) =>
        withEntryTimes({ submitToChallenge: jest.fn(submit), swapPhoto: jest.fn(swap) }, createMemoryEntryAgeLedger());
    const noAnswer: ActionResult = { ok: false, raw: null };

    test('pending: no answer reserves, and a reserved photo is not offered again', async () => {
        arrangePool();
        await wrap(async () => noAnswer).submitToChallenge(7, ['p1'], 'tok');
        expect(progress()).toEqual({ consumed: [], reserved: ['p1'] });
        expect(view()?.ids).toEqual(['p2', 'p3']);
    });

    test('unclear: a swap that may have been spent reserves its photo', async () => {
        arrangePool();
        await wrap(
            async () => noAnswer,
            async () => ({ ok: false, raw: null, unclear: true }),
        ).swapPhoto(7, 'old', 'p2', 'tok');
        expect(progress()).toEqual({ consumed: [], reserved: ['p2'] });
    });

    test('a request that threw is reserved too, and the error goes on', async () => {
        arrangePool();
        const wrapped = wrap(async () => {
            throw new Error('socket closed');
        });
        await expect(wrapped.submitToChallenge(7, ['p1'], 'tok')).rejects.toThrow('socket closed');
        await expect(wrapped.swapPhoto(7, 'old', 'p2', 'tok')).rejects.toThrow('socket closed');
        expect(progress()).toEqual({ consumed: [], reserved: ['p1', 'p2'] });
    });

    test('a refusal the server answered reserves nothing: the photo was not taken', async () => {
        arrangePool();
        const wrapped = wrap(async () => ({ ok: false, raw: { success: false } }));
        await wrapped.submitToChallenge(7, ['p1'], 'tok');
        await wrapped.swapPhoto(7, 'old', 'p2', 'tok');
        expect(state().poolProgress).toBeUndefined();
    });

    test('positive reconciliation: a reserved photo that shows as entered is consumed', async () => {
        arrangePool();
        await wrap(async () => noAnswer).submitToChallenge(7, ['p1'], 'tok');
        expect(settings.reconcilePhotoPool(7, ['existing', 'p1'])).toBe(true);
        expect(progress()).toEqual({ consumed: ['p1'], reserved: [] });
        expect(view()?.ids).toEqual(['p2', 'p3']);
    });

    test('a reconciled failure releases the photo to be offered again', async () => {
        arrangePool();
        await wrap(async () => noAnswer).submitToChallenge(7, ['p1'], 'tok');
        expect(settings.reconcilePhotoPool(7, ['existing'])).toBe(true);
        expect(state().poolProgress).toBeUndefined();
        expect(view()?.ids).toEqual(['p1', 'p2', 'p3']);
    });

    test('a photo that is reserved again after it landed is not reserved: consumed wins', async () => {
        arrangePool();
        await wrap(async () => ({ ok: true, raw: { success: true } })).submitToChallenge(7, ['p1'], 'tok');
        await wrap(async () => noAnswer).submitToChallenge(7, ['p1'], 'tok');
        expect(progress()).toEqual({ consumed: ['p1'], reserved: [] });
    });

    test('a failure of the progress write is logged and never changes the result', async () => {
        arrangePool();
        store.keys.set('gs_scenario_state', '{broken');
        const result = await wrap(async () => ({ ok: true, raw: { success: true } })).submitToChallenge(
            7,
            ['p1'],
            'tok',
        );
        expect(result.ok).toBe(true);
    });
});

describe('a submit through the fill path honours the pool, and never widens past it', () => {
    const NOW = 1_000_000;
    const photo = (id: string): PickerPhoto => ({
        id,
        labels: ['Pink'],
        upload_date: 9000,
        permission: { allowed: true, message: null },
    });
    const library = ['p1', 'p2', 'p3', 'free'].map(photo);
    const live = (): Challenge =>
        buildChallenge({
            id: '7',
            title: 'Big show',
            url: 'big-show1',
            max_photo_submits: 4,
            close_time: NOW + 600,
            member: { ranking: { entries: [{ id: 'existing' }] } },
        });
    const depsFor = () => {
        const submitToChallenge = jest.fn(async () => invalid<ActionResult>({ ok: true, raw: { success: true } }));
        const getEligiblePhotos = jest.fn(async () => library);
        const deps = invalid<FillDeps & { settings: typeof settings }>({
            settings,
            logger: loggerModule,
            getEligiblePhotos,
            getEligiblePhotosWalk: jest.fn(async () => ({ items: library, truncated: false, nextStart: 4 })),
            getSemanticScores: jest.fn(async () => null),
            rankVisually: jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number) => ids.slice(0, want)),
            getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-1', userName: 'u' })),
            submitToChallenge,
            wallClockNow: () => NOW,
        });
        return { deps, submitToChallenge, getEligiblePhotos };
    };
    const sent = (submit: { mock: { calls: unknown[][] } }) => submit.mock.calls.map((call) => call[1]);

    test('in order: the pool’s first photo goes in, then the next once it is consumed', async () => {
        arrangePool();
        const first = depsFor();
        await expect(submitNewEntryForAction(live(), 'tok', first.deps)).resolves.toMatchObject({
            ok: true,
            imageId: 'p1',
        });
        settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] });
        const second = depsFor();
        await submitNewEntryForAction(live(), 'tok', second.deps);
        expect(sent(second.submitToChallenge)).toEqual([['p2']]);
    });

    test('an exhausted pool with only blocks selection: nothing is fetched or submitted', async () => {
        arrangePool();
        settings.recordPhotoPoolEvents(7, { consume: ['p1', 'p2', 'p3'], reserve: [] });
        expect(settings.getChosenPoolView(7)?.block ?? null).toBe('pool-exhausted');
        const { deps, submitToChallenge, getEligiblePhotos } = depsFor();
        const exhaustedChosenOnly = await submitNewEntryForAction(live(), 'tok', deps);
        expect(exhaustedChosenOnly).toEqual({ ok: false, imageId: null, reason: 'pool-exhausted' });
        expect(exhaustedChosenOnly.reason).toBe('pool-exhausted');
        expect(submitToChallenge).not.toHaveBeenCalled();
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('reserved photos count as given out: a pool whose rest is reserved is exhausted', async () => {
        arrangePool(['p1', 'p2']);
        settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: ['p2'] });
        expect(settings.getChosenPoolView(7)?.block ?? null).toBe('pool-exhausted');
    });

    test('an unbound pool with only blocks selection', async () => {
        arrangePool(null);
        expect(settings.getChosenPoolView(7)?.block ?? null).toBe('pool-unbound');
        const { deps, submitToChallenge } = depsFor();
        await expect(submitNewEntryForAction(live(), 'tok', deps)).resolves.toEqual({
            ok: false,
            imageId: null,
            reason: 'pool-unbound',
        });
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test.each([
        ['unbound', null],
        ['exhausted', ['p1']],
    ])('without only, a %s pool falls through to normal picking', async (_label, pool) => {
        arrangePool(pool, { ...POOL_PLAN, phases: { feed: { photoPool: { name: 'Wall' } }, rest: {} } });
        if (pool) settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] });
        expect(settings.getChosenPoolView(7)?.block ?? null).toBeNull();
        const { deps, submitToChallenge } = depsFor();
        const result = await submitNewEntryForAction(live(), 'tok', deps);
        expect(result.ok).toBe(true);
        expect(sent(submitToChallenge)).toHaveLength(1);
    });

    test('the swap ranking and the suggestions are blocked the same way', async () => {
        arrangePool(['p1']);
        settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] });
        const { deps, getEligiblePhotos } = depsFor();
        const { rankCandidatesForChallenge } = require('../../src/ts/core/services/autoFill') as typeof autoFillModule;
        await expect(
            rankCandidatesForChallenge(live(), 'tok', deps, { label: 'swap', enforceChosenOnly: true }),
        ).resolves.toMatchObject({ status: 'ranked', picked: [], noChosenLeft: true });
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });
});

describe('settling pool progress when the record moves under the read', () => {
    const reservedP1 = (): ScenarioState => ({
        ...initialState('Queue', 'feed', 1000),
        poolProgress: { feed: { consumed: [], reserved: ['p1'] } },
    });

    test('a pool that is not saved, or a phase without one, offers nothing to consume; reserved photos still settle', () => {
        arrangePool(null);
        expect(settings.recordPhotoPoolEvents(7, { consume: ['p1'], reserve: [] })).toBe(false);
        enterPhase('feed', reservedP1());
        expect(settings.reconcilePhotoPool(7, ['p1'])).toBe(true);
        expect(progress()).toEqual({ consumed: ['p1'], reserved: [] });
        // Pools are saved, but not this one.
        settings.setPhotoPool('Other', ['x']);
        enterPhase('feed', reservedP1());
        expect(settings.reconcilePhotoPool(7, [])).toBe(true);
        expect(state().poolProgress).toBeUndefined();
    });

    test('a reserve left in a phase that draws from no pool is still settled by a read, and nothing is consumed from it', () => {
        arrangePool();
        enterPhase('rest', { poolProgress: { rest: { consumed: [], reserved: ['p1'] } } });
        expect(reconcilePoolProgress(settings.loadSettings(), '8', ['p1'])).toBe(false);
        expect(settings.reconcilePhotoPool(7, ['p1', 'p2'])).toBe(true);
        expect(state().poolProgress?.rest).toEqual({ consumed: ['p1'], reserved: [] });
        expect(recordPoolEvents(settings.loadSettings(), '7', { consume: ['p2'], reserve: [] })).toBe(false);
    });

    test('a record that moved to a phase without a pool, or is gone, between the read and the write records nothing', async () => {
        arrangePool();
        const get = jest.spyOn(scenarioStateLedger, 'get');
        const read = () => ({
            corrupt: false as const,
            state: initialState('Queue', 'feed', 1000),
            epoch: { all: 0, gen: 0 },
        });
        enterPhase('rest');
        get.mockReturnValueOnce(read());
        expect(recordPoolEvents(settings.loadSettings(), '7', { consume: ['p1'], reserve: [] })).toBe(false);
        await scenarioStateLedger.remove(7);
        get.mockReturnValueOnce(read());
        expect(recordPoolEvents(settings.loadSettings(), '7', { consume: ['p1'], reserve: [] })).toBe(false);
        get.mockRestore();
    });

    test('a record that is gone, or already settled, between the read and the write is left alone', async () => {
        arrangePool();
        const get = jest.spyOn(scenarioStateLedger, 'get');
        const read = () => ({ corrupt: false as const, state: reservedP1(), epoch: { all: 0, gen: 0 } });
        // Read: a reserved photo. Written under the lock: no record at all.
        await scenarioStateLedger.remove(7);
        get.mockReturnValueOnce(read());
        expect(reconcilePoolProgress(settings.loadSettings(), '7', [])).toBe(false);
        // Read: a reserved photo. Written under the lock: a record with nothing to settle.
        enterPhase('feed');
        get.mockReturnValueOnce(read());
        expect(reconcilePoolProgress(settings.loadSettings(), '7', [])).toBe(false);
        expect(state().poolProgress).toBeUndefined();
        get.mockRestore();
    });
});

describe('a join draws from the pool of the phase an un-joined candidate is in', () => {
    const photo = (id: string): PickerPhoto => ({
        id,
        labels: ['Pink'],
        upload_date: 9000,
        permission: { allowed: true, message: null },
    });
    const library = ['p1', 'p2', 'free'].map(photo);
    const candidate = () => invalid<Challenge>({ id: 7, title: 'Pink Flowers', url: 'pink-flowers7' });
    const joinDeps = (result: ActionResult) => {
        const submit = jest.fn(async () => result);
        const wrapped = withEntryTimes(
            { submitToChallenge: submit, swapPhoto: jest.fn() },
            createMemoryEntryAgeLedger(),
        ).submitToChallenge;
        const deps = invalid<Parameters<typeof performJoin>[2]>({
            getMemberChallenges: jest.fn(async () => []),
            getBankroll: jest.fn(async () => ({ coins: 1000 })),
            coinsUnlock: jest.fn(async () => ({ ok: true })),
            submitToChallenge: wrapped,
            getEligiblePhotos: jest.fn(async () => library),
            getEligiblePhotosWalk: jest.fn(async () => ({ items: library, truncated: false, nextStart: 3 })),
            getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-1', userName: 'u' })),
            joinStateStore: { readRaw: () => null, writeRaw: () => {} },
        });
        return { deps, submit };
    };
    const ok: ActionResult = { ok: true, raw: { success: true } };

    beforeEach(() => {
        arrangePool(['p1', 'p2']);
        inFlight.clear();
    });

    test('each confirmed join takes the next photo of the pool and consumes it once; an exhausted pool then blocks', async () => {
        const first = joinDeps(ok);
        await expect(performJoin(candidate(), 'tok', first.deps, 0)).resolves.toMatchObject({
            status: 'joined',
            imageId: 'p1',
        });
        expect(progress()).toEqual({ consumed: ['p1'], reserved: [] });
        const second = joinDeps(ok);
        await expect(performJoin(candidate(), 'tok', second.deps, 0)).resolves.toMatchObject({ imageId: 'p2' });
        expect(progress()?.consumed).toEqual(['p1', 'p2']);
        const third = joinDeps(ok);
        await expect(performJoin(candidate(), 'tok', third.deps, 50)).resolves.toEqual({
            status: 'skipped-no-chosen',
            charged: 0,
        });
        expect(third.submit).not.toHaveBeenCalled();
        expect(third.deps.coinsUnlock).not.toHaveBeenCalled();
        expect(third.deps.getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('a paid join whose submit got no answer reserves the photo, and the next read settles it', async () => {
        const unclear = joinDeps({ ok: false, raw: null });
        await expect(performJoin(candidate(), 'tok', unclear.deps, 50)).resolves.toMatchObject({
            status: 'charged-pending-submit',
        });
        expect(progress()).toEqual({ consumed: [], reserved: ['p1'] });
        expect(view()?.ids).toEqual(['p2']);
        expect(settings.reconcilePhotoPool(7, ['p1'])).toBe(true);
        expect(progress()).toEqual({ consumed: ['p1'], reserved: [] });
    });

    test('with no record of the scenario, or one of another, the candidate has no pool', () => {
        const name = 'Queue';
        const poolView = (id: string | number, scenario: string) => settings.getPoolViewFor(id, scenario);
        expect(poolView(7, name)).toMatchObject({ name: 'Wall', ids: ['p1', 'p2'] });
        expect(poolView(7, 'queue')).toMatchObject({ name: 'Wall' });
        expect(poolView(8, name)).toBeNull();
        expect(poolView(7, 'Other')).toBeNull();
        enterPhase('gone');
        expect(poolView(7, name)).toBeNull();
        enterPhase('rest');
        expect(poolView(7, name)).toBeNull();
    });

    test('a user without scenarios reads nothing', () => {
        removeHeadlessStore();
        store = installHeadlessStore();
        expect(settings.getPoolViewFor(7, 'Queue')).toBeNull();
    });
});

describe('the pins a challenge has in force', () => {
    const arrangePins = (phase = 'main', runtimePins?: ScenarioState['phasePins']) => {
        if (!settings.getScenario('Pins')) expect(settings.saveScenario(PIN_PLAN)).toMatchObject({ ok: true });
        settings.setChallengeOverride('scenario', '7', 'Pins');
        expect(
            scenarioStateLedger.set(7, {
                ...initialState('Pins', phase, 1000),
                ...(runtimePins ? { phasePins: runtimePins } : {}),
            }),
        ).toBe('saved');
    };
    const pins = () => settings.getEntryPins(7);

    test('without a scenario they are the saved pins, and the saved read is the same', () => {
        settings.setEntryPin('boost', '7', 'savedBoost');
        settings.setEntryPin('turbo', '7', 'savedTurbo');
        expect(pins()).toEqual({ boost: 'savedBoost', turbo: 'savedTurbo' });
        expect(settings.getStoredEntryPins(7)).toEqual(pins());
    });

    test('precedence: runtime pin, then phase pin, then saved pin; a power left out inherits', () => {
        settings.setEntryPin('boost', '7', 'savedBoost');
        settings.setEntryPin('turbo', '7', 'savedTurbo');
        arrangePins('main');
        expect(pins()).toEqual({ boost: 'phaseBoost', turbo: 'savedTurbo' });
        arrangePins('main', { boost: 'runBoost', turbo: 'runTurbo' });
        expect(pins()).toEqual({ boost: 'runBoost', turbo: 'runTurbo' });
        arrangePins('main', { turbo: 'runTurbo' });
        expect(pins()).toEqual({ boost: 'phaseBoost', turbo: 'runTurbo' });
    });

    test('an explicit null suppresses the lower tiers, in the phase and at run time', () => {
        settings.setEntryPin('boost', '7', 'savedBoost');
        settings.setEntryPin('turbo', '7', 'savedTurbo');
        arrangePins('quiet');
        expect(pins()).toEqual({ boost: null, turbo: null });
        arrangePins('main', { boost: null });
        expect(pins()).toEqual({ boost: null, turbo: 'savedTurbo' });
    });

    test('leaving the phase restores the saved pins, and the saved pins are never written', () => {
        settings.setEntryPin('boost', '7', 'savedBoost');
        const storedBefore = store.value;
        arrangePins('main', { boost: 'runBoost' });
        const withPhase = store.value;
        expect(pins().boost).toBe('runBoost');
        arrangePins('other');
        expect(pins()).toEqual({ boost: 'savedBoost', turbo: null });
        expect(settings.getStoredEntryPins(7)).toEqual({ boost: 'savedBoost', turbo: null });
        // Reading the pins in force changed no byte of the configuration; the scenario assignment is the only write.
        expect(store.value).toBe(withPhase);
        expect(parseJsonAs(storedBefore as string, isConfig).challenges['7'].pins).toEqual({ boost: 'savedBoost' });
        expect(parseJsonAs(withPhase as string, isConfig).challenges['7'].pins).toEqual({ boost: 'savedBoost' });
    });

    test('a photo is pinned for one power only: the pin from the lower tier gives it up', () => {
        settings.setEntryPin('boost', '7', 'shared');
        arrangePins('other', { turbo: 'shared' });
        expect(pins()).toEqual({ boost: null, turbo: 'shared' });
        arrangePins('main', { boost: 'runBoost' });
        settings.setEntryPin('turbo', '7', 'phaseBoost');
        expect(pins()).toEqual({ boost: 'runBoost', turbo: 'phaseBoost' });
        arrangePins('main');
        expect(pins()).toEqual({ boost: 'phaseBoost', turbo: null });
    });

    test('an unreadable record reads the saved pins; the pass itself skips such a challenge', () => {
        settings.setEntryPin('boost', '7', 'savedBoost');
        arrangePins('main');
        store.keys.set('gs_scenario_state', '{broken');
        expect(pins()).toEqual({ boost: 'savedBoost', turbo: null });
    });

    test('mergeEntryPins is pure: equal tiers keep both, and the tiers are never mutated', () => {
        const runtimePins = { boost: 'x' };
        expect(mergeEntryPins({ boost: null, turbo: 'x' }, undefined, runtimePins)).toEqual({
            boost: 'x',
            turbo: null,
        });
        expect(mergeEntryPins({ boost: 'x', turbo: 'x' })).toEqual({ boost: 'x', turbo: 'x' });
        expect(runtimePins).toEqual({ boost: 'x' });
    });
});

describe('the account’s photo pools', () => {
    test('save, read back a copy, replace', () => {
        expect(settings.getPhotoPools()).toEqual({});
        expect(settings.setPhotoPool('Wall', ['a', 'b'])).toBe('ok');
        const pools = settings.getPhotoPools();
        pools.Wall.push('mutated');
        expect(settings.getPhotoPools()).toEqual({ Wall: ['a', 'b'] });
        expect(settings.setPhotoPool('Wall', ['b', 'c'])).toBe('ok');
        expect(settings.getPhotoPools()).toEqual({ Wall: ['b', 'c'] });
    });

    test.each([
        ['a name with a line break', 'Wa\nll', ['a']],
        ['an empty name', '', ['a']],
        ['a name with spaces around it', ' Wall', ['a']],
        ['a name an object already has', 'constructor', ['a']],
        ['a name that is too long', 'x'.repeat(61), ['a']],
        ['an empty list', 'Wall', []],
        ['a repeated photo', 'Wall', ['a', 'a']],
        ['a photo id of the wrong shape', 'Wall', ['a b']],
        ['too many photos', 'Wall', Array.from({ length: 101 }, (_unused, at) => `p${at}`)],
        ['a list that is not one', 'Wall', invalid<string[]>('abc')],
    ])('refuses %s', (_label, name, ids) => {
        expect(settings.setPhotoPool(name, ids)).toBe('invalid');
        expect(settings.getPhotoPools()).toEqual({});
    });

    test('at most the cap of pools; a pool of an existing name still replaces', () => {
        for (let at = 0; at < 20; at++) expect(settings.setPhotoPool(`Pool ${at}`, ['a'])).toBe('ok');
        expect(settings.setPhotoPool('One too many', ['a'])).toBe('cap');
        expect(settings.setPhotoPool('Pool 3', ['b'])).toBe('ok');
    });

    test('a write that fails is reported', () => {
        store.write.mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(settings.setPhotoPool('Wall', ['a'])).toBe('write-failed');
    });

    describe('creating a pool never replaces one', () => {
        test.each(['Wall', 'wall', 'WALL'])(
            'a name another pool holds (%s) is refused and the pool is left as it was',
            (name) => {
                expect(settings.setPhotoPool('Wall', ['a', 'b'])).toBe('ok');
                expect(settings.createPhotoPool(name, ['z'])).toBe('exists');
                expect(settings.getPhotoPools()).toEqual({ Wall: ['a', 'b'] });
            },
        );

        test('a new name is created, and a plain save of an existing name still replaces', () => {
            expect(settings.createPhotoPool('Wall', ['a'])).toBe('ok');
            expect(settings.setPhotoPool('Wall', ['c'])).toBe('ok');
            expect(settings.getPhotoPools()).toEqual({ Wall: ['c'] });
        });

        test('another writer’s pool saved after this one looked is neither replaced by a create nor erased by any pool write', () => {
            expect(settings.setPhotoPool('Mine', ['m'])).toBe('ok');
            settings.getPhotoPools();
            // Another process (the CLI) saves `Beach` between this one's read and its write.
            const other = (stored: Record<string, string[]>) => {
                store.value = JSON.stringify({ ...parseJsonObject(store.value as string), photoPools: stored });
            };
            other({ Mine: ['m'], Beach: ['x'] });
            expect(settings.createPhotoPool('beach', ['z'])).toBe('exists');
            expect(settings.getPhotoPools()).toEqual({ Mine: ['m'], Beach: ['x'] });
            other({ Mine: ['m'], Beach: ['x'], Late: ['l'] });
            expect(settings.setPhotoPool('Wall', ['w'])).toBe('ok');
            expect(settings.getPhotoPools()).toEqual({ Mine: ['m'], Beach: ['x'], Late: ['l'], Wall: ['w'] });
        });

        test('a malformed name or list is still invalid, and the cap still holds', () => {
            expect(settings.createPhotoPool('', ['a'])).toBe('invalid');
            for (let at = 0; at < 20; at++) expect(settings.createPhotoPool(`Pool ${at}`, ['a'])).toBe('ok');
            expect(settings.createPhotoPool('One too many', ['a'])).toBe('cap');
        });
    });

    test('a malformed pool is dropped on load, the others stay, and the drop is logged once', () => {
        const category = logger.withCategory('settings');
        settings.setPhotoPool('Good', ['a']);
        const text = JSON.stringify({
            ...JSON.parse(store.value as string),
            photoPools: { Good: ['a'], Bad: ['a', 'a'], 'Odd\nname': ['a'], NotAList: 'a' },
        });
        jest.mocked(category.warning).mockClear();
        store.value = text;
        expect(settings.getPhotoPools()).toEqual({ Good: ['a'] });
        expect(settings.getPhotoPools()).toEqual({ Good: ['a'] });
        const drops = jest.mocked(category.warning).mock.calls.filter(([line]) => String(line).includes('photoPools.'));
        expect(drops).toHaveLength(1);
        expect(drops[0][0]).toContain('photoPools.Bad, photoPools.Odd name, photoPools.NotAList');
    });

    test('a container that is not a map leaves no pools', () => {
        settings.setPhotoPool('Good', ['a']);
        store.value = JSON.stringify({ ...JSON.parse(store.value as string), photoPools: ['a'] });
        expect(settings.getPhotoPools()).toEqual({});
    });

    test('a pool past the cap is dropped on load', () => {
        const many = Object.fromEntries(Array.from({ length: 22 }, (_unused, at) => [`Pool ${at}`, ['a']]));
        settings.setPhotoPool('Good', ['a']);
        store.value = JSON.stringify({ ...JSON.parse(store.value as string), photoPools: many });
        expect(Object.keys(settings.getPhotoPools())).toHaveLength(20);
    });
});

describe('deleting or renaming a pool a stored scenario uses goes through the lifecycle gate', () => {
    test('delete and rename an unused pool', () => {
        settings.setPhotoPool('Wall', ['a']);
        expect(settings.renamePhotoPool('Wall', 'Fence')).toEqual({ ok: true });
        expect(settings.getPhotoPools()).toEqual({ Fence: ['a'] });
        expect(settings.deletePhotoPool('Fence')).toEqual({ ok: true });
        expect(settings.getPhotoPools()).toEqual({});
    });

    test.each([
        ['a delete of a pool that is not saved', () => settings.deletePhotoPool('Nope'), 'not-found'],
        ['a rename of a pool that is not saved', () => settings.renamePhotoPool('Nope', 'Wall2'), 'not-found'],
        ['a rename onto a name in use', () => settings.renamePhotoPool('Wall', 'Fence'), 'exists'],
        ['a rename onto itself', () => settings.renamePhotoPool('Wall', 'Wall'), 'exists'],
        ['a delete of a malformed name', () => settings.deletePhotoPool(' '), 'invalid'],
        ['a rename to a malformed name', () => settings.renamePhotoPool('Wall', 'a\nb'), 'invalid'],
        ['a rename from a malformed name', () => settings.renamePhotoPool('', 'Wall2'), 'invalid'],
    ])('refuses %s', (_label, change, reason) => {
        settings.setPhotoPool('Wall', ['a']);
        settings.setPhotoPool('Fence', ['b']);
        expect(change()).toEqual({ ok: false, reason });
        expect(settings.getPhotoPools()).toEqual({ Wall: ['a'], Fence: ['b'] });
    });

    test('a pool a scenario draws from is refused while a plan using that scenario has unresolved work, then goes', () => {
        arrangePool();
        scenarioStateLedger.set(7, {
            ...initialState('Queue', 'feed', 1000),
            inFlight: { ruleId: 'feed-1', actionIndex: 0, pending: 'swap' },
        });
        expect(settings.deletePhotoPool('Wall')).toEqual({ ok: false, reason: 'unresolved-work' });
        expect(settings.renamePhotoPool('Wall', 'Fence')).toEqual({ ok: false, reason: 'unresolved-work' });
        expect(settings.getPhotoPools()).toEqual({ Wall: ['p1', 'p2', 'p3'] });
        enterPhase('feed');
        expect(settings.deletePhotoPool('Wall')).toEqual({ ok: true });
        // The scenario is left as it is: it names a pool the account no longer has.
        expect(settings.getScenario('Queue')?.phases.feed.photoPool).toEqual({
            name: 'Wall',
            only: true,
            inOrder: true,
        });
        expect(settings.getChosenPoolView(7)?.block ?? null).toBe('pool-unbound');
    });

    test('a delete that cannot be saved is reported', () => {
        settings.setPhotoPool('Wall', ['a']);
        store.write.mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(settings.deletePhotoPool('Wall')).toEqual({ ok: false, reason: 'not-saved' });
    });

    test('a stored scenario that no longer validates names no pool', () => {
        settings.setPhotoPool('Wall', ['a']);
        store.value = JSON.stringify({
            ...JSON.parse(store.value as string),
            scenarios: { Broken: { name: 'Broken' } },
        });
        expect(settings.deletePhotoPool('Wall')).toEqual({ ok: true });
    });
});

describe('the scenario document: pins, pools and the two actions', () => {
    const phase = (extra: object, rules: object[] = []) => ({
        name: 'Plan',
        version: 1,
        start: 'main',
        phases: { main: { ...extra, ...(rules.length ? { rules } : {}) } },
    });
    const issues = (doc: object) => {
        const result = settings.checkScenario(doc);
        expect(result.ok).toBe(false);
        return result.ok ? [] : result.issues;
    };

    test('accepts pins, a pool and both actions in an active rule', () => {
        const doc = phase(
            { pins: { boost: 'a', turbo: null }, photoPool: { name: 'Wall', only: true, inOrder: false } },
            [
                {
                    do: [
                        { type: 'setPin', power: 'boost', entry: { by: 'slot', index: 1 } },
                        { type: 'clearPin', power: 'turbo' },
                    ],
                },
            ],
        );
        expect(settings.checkScenario(doc)).toMatchObject({ ok: true });
    });

    test.each([
        ['a pin that is no photo id', { pins: { boost: 'a b' } }, 'phases.main.pins.boost'],
        ['a pin key that is no power', { pins: { both: 'a' } }, 'phases.main.pins'],
        ['a pool with no name', { photoPool: {} }, 'phases.main.photoPool.name'],
        ['a pool name with a line break', { photoPool: { name: 'a\nb' } }, 'phases.main.photoPool.name'],
        ['a pool key that is not known', { photoPool: { name: 'Wall', ids: ['a'] } }, 'phases.main.photoPool'],
    ])('refuses %s', (_label, extra, path) => {
        expect(issues(phase(extra)).map((issue) => issue.path)).toContain(path);
    });

    test('refuses one photo pinned for both powers', () => {
        expect(issues(phase({ pins: { boost: 'a', turbo: 'a' } }))).toEqual([
            { path: 'phases.main.pins', message: 'A photo is pinned for Boost or Turbo, not both' },
        ]);
        // Two different photos, or one pinned and one suppressed, are fine.
        expect(settings.checkScenario(phase({ pins: { boost: 'a', turbo: 'b' } })).ok).toBe(true);
        expect(settings.checkScenario(phase({ pins: { boost: null, turbo: null } })).ok).toBe(true);
    });

    test.each(['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder'])(
        'a pool and the phase’s own %s are not held together',
        (key) => {
            const value = key === 'chosenPhotos' ? ['a'] : true;
            expect(issues(phase({ photoPool: { name: 'Wall' }, settings: { [key]: value } }))).toEqual([
                { path: 'phases.main.photoPool', message: `A photo pool replaces ${key}: remove one of them` },
            ]);
        },
    );

    test('a pool beside other phase settings is fine', () => {
        expect(settings.checkScenario(phase({ photoPool: { name: 'Wall' }, settings: { autoSubmit: false } })).ok).toBe(
            true,
        );
    });

    test('an installation scenario holds neither pins nor a pool, and offers neither action', () => {
        const doc = {
            ...phase({ pins: { boost: 'a' }, photoPool: { name: 'Wall' } }, [
                { do: [{ type: 'setPin', power: 'boost', entry: { by: 'slot', index: 1 } }] },
            ]),
            scope: 'installation',
        };
        const found = issues(doc);
        expect(found.map((issue) => issue.path)).toEqual(
            expect.arrayContaining(['phases.main.pins', 'phases.main.photoPool']),
        );
        expect(found.some((issue) => issue.message.includes('setPin is not available'))).toBe(true);
    });

    test('the actions are for active challenges only', () => {
        const rule = { stages: ['preJoin'], do: [{ type: 'clearPin', power: 'boost' }] };
        expect(issues(phase({}, [rule])).some((issue) => issue.message.includes('clearPin is not available'))).toBe(
            true,
        );
    });

    test('the action shapes are strict', () => {
        const bad = [
            { type: 'setPin', power: 'both', entry: { by: 'slot', index: 1 } },
            { type: 'setPin', power: 'boost' },
            { type: 'clearPin', power: 'boost', entry: { by: 'slot', index: 1 } },
        ];
        for (const action of bad) expect(settings.checkScenario(phase({}, [{ do: [action] }])).ok).toBe(false);
    });

    test('the vocabulary lists the new fields and actions, and the helpers say what a pool name and list are', () => {
        const listed = vocabulary.VOCABULARY_REFERENCE.map(([kind, type]) => `${kind}:${type}`);
        expect(listed).toEqual(
            expect.arrayContaining(['action:setPin', 'action:clearPin', 'phase:pins', 'phase:photoPool']),
        );
        expect(vocabulary.STAGE_ACTIONS.active).toEqual(expect.arrayContaining(['setPin', 'clearPin']));
        expect(vocabulary.STAGE_ACTIONS.preJoin).not.toContain('setPin');
        expect(vocabulary.isPoolName('Wall')).toBe(true);
        expect(vocabulary.isPoolName(7)).toBe(false);
        expect(vocabulary.isPoolIds(['a', 'b'])).toBe(true);
        expect(vocabulary.isPoolIds('ab')).toBe(false);
        expect(vocabulary.isPhotoId('entry_007')).toBe(true);
    });
});

describe('export and import carry the pool name, never the photos', () => {
    test('an export names the pool and holds no photo id; an import reports the pools this account lacks', () => {
        arrangePool();
        const exported = settings.exportScenario('Queue') as string;
        expect(parseJsonAs(exported, isScenarioText).phases.feed.photoPool).toEqual({
            name: 'Wall',
            only: true,
            inOrder: true,
        });
        for (const id of ['p1', 'p2', 'p3']) expect(exported).not.toContain(id);

        // Another account: no pool of that name.
        removeHeadlessStore();
        store = installHeadlessStore();
        const preview = settings.previewScenarioImport(exported);
        expect(preview).toMatchObject({ ok: true, exists: false, unboundPools: ['Wall'] });
        expect(preview.ok && preview.preview.pools).toEqual(['Wall']);
        expect(settings.importScenario(exported)).toEqual({ ok: true, name: 'Queue', unboundPools: ['Wall'] });
        // Binding it settles the requirement; the scenario was stored all the same.
        settings.setPhotoPool('Wall', ['x']);
        expect(settings.previewScenarioImport(exported)).toMatchObject({ ok: true, exists: true, unboundPools: [] });
        expect(settings.importScenario(exported, { overwrite: true, expectedDefinitionRevision: 1 })).toEqual({
            ok: true,
            name: 'Queue',
            unboundPools: [],
        });
    });

    test('a failed import is the failure it always was', () => {
        expect(settings.importScenario('{')).toMatchObject({ ok: false });
    });
});

describe('the ledger holds only well-formed pins and pool progress', () => {
    const write = (extra: object) => {
        scenarioStateLedger.change('9', () => ({ ...initialState('Plan', 'main', 1), ...extra }));
        return scenarioStateLedger.get(9);
    };

    test('well-formed ones read back', () => {
        const ok = write({
            phasePins: { boost: 'a', turbo: null },
            poolProgress: { main: { consumed: ['a'], reserved: ['b'] } },
        });
        expect(ok.corrupt).toBe(false);
        expect(ok.state).toMatchObject({ phasePins: { boost: 'a', turbo: null } });
    });

    test.each([
        ['pins that are not a map', { phasePins: [] }],
        ['a pin of a power that does not exist', { phasePins: { both: 'a' } }],
        ['a pin that is no photo id', { phasePins: { boost: 'a b' } }],
        ['a pin that is a number', { phasePins: { boost: 5 } }],
        ['progress that is not a map', { poolProgress: [] }],
        [
            'progress of too many phases',
            {
                poolProgress: Object.fromEntries(
                    Array.from({ length: 21 }, (_u, i) => [`p${i}`, { consumed: [], reserved: [] }]),
                ),
            },
        ],
        ['progress for a phase with no name', { poolProgress: { '': { consumed: [], reserved: [] } } }],
        ['progress with an extra key', { poolProgress: { main: { consumed: [], reserved: [], extra: [] } } }],
        ['progress that is not a record', { poolProgress: { main: [] } }],
        ['consumed that is not a list', { poolProgress: { main: { consumed: 'a', reserved: [] } } }],
        ['a photo consumed twice', { poolProgress: { main: { consumed: ['a', 'a'], reserved: [] } } }],
        ['a photo id of the wrong shape', { poolProgress: { main: { consumed: ['a b'], reserved: [] } } }],
        ['a photo both consumed and reserved', { poolProgress: { main: { consumed: ['a'], reserved: ['a'] } } }],
        [
            'too many reserved',
            { poolProgress: { main: { consumed: [], reserved: Array.from({ length: 101 }, (_u, i) => `p${i}`) } } },
        ],
    ])('refuses %s', (_label, extra) => {
        expect(write(extra).corrupt).toBe('record');
    });
});

describe('the reducer', () => {
    const { applyEffects, withPoolEvents, finishScenarioRule, reduceScenarioOutcome } = runtime;
    const base = (extra: Partial<ScenarioState> = {}): ScenarioState => ({
        ...initialState('Plan', 'main', 100),
        ...extra,
    });
    const step = {
        ruleId: 'r',
        index: 0,
        actionType: 'enterPhoto',
        at: 200,
        timezone: 'UTC',
        committed: false,
        noticeToken: 't',
        message: 'm',
    };

    test('a pin sets the power; a cleared one is an explicit null; a photo pinned for one power leaves the other', () => {
        let next = applyEffects(base(), { pin: { power: 'boost', id: 'a' } }, 200, 't');
        expect(next.phasePins).toEqual({ boost: 'a' });
        next = applyEffects(next, { pin: { power: 'turbo', id: 'a' } }, 200, 't');
        expect(next.phasePins).toEqual({ turbo: 'a' });
        next = applyEffects(next, { pin: { power: 'turbo', id: null } }, 200, 't');
        expect(next.phasePins).toEqual({ turbo: null });
        next = applyEffects(next, { pin: { power: 'boost', id: 'b' } }, 200, 't');
        expect(next.phasePins).toEqual({ turbo: null, boost: 'b' });
    });

    test('pool events: consume once, reserve, release, and a photo is in one list only', () => {
        let next = withPoolEvents(base(), { consume: ['a', 'a'], reserve: ['b', 'b'] });
        expect(next.poolProgress).toEqual({ main: { consumed: ['a'], reserved: ['b'] } });
        next = withPoolEvents(next, { reserve: ['a', 'c'], consume: ['b'] });
        expect(next.poolProgress).toEqual({ main: { consumed: ['a', 'b'], reserved: ['c'] } });
        next = withPoolEvents(next, { release: ['c'] });
        expect(next.poolProgress).toEqual({ main: { consumed: ['a', 'b'], reserved: [] } });
        // Another phase keeps its own.
        next = withPoolEvents({ ...next, phase: 'other' }, { consume: ['z'] });
        expect(Object.keys(next.poolProgress ?? {}).sort()).toEqual(['main', 'other']);
        // Nothing left in a phase: the entry goes, and with the last one the field.
        const cleared = withPoolEvents(withPoolEvents(base(), { reserve: ['a'] }), { release: ['a'] });
        expect(cleared.poolProgress).toBeUndefined();
    });

    test('the record keeps at most the cap of consumed photos and of reserved ones', () => {
        const many = Array.from({ length: 600 }, (_u, i) => `p${i}`);
        const next = withPoolEvents(base(), { consume: many });
        expect(next.poolProgress?.main.consumed).toHaveLength(500);
        expect(withPoolEvents(base(), { reserve: many }).poolProgress?.main.reserved).toHaveLength(100);
    });

    test('a done step applies the pin and the pool events; a step that stopped applies the pool events too', () => {
        const done = reduceScenarioOutcome(base(), step, {
            status: 'done',
            pin: { power: 'boost', id: 'a' },
            pool: { consume: ['p1'] },
        });
        expect(done.phasePins).toEqual({ boost: 'a' });
        expect(done.poolProgress?.main.consumed).toEqual(['p1']);
        const failed = reduceScenarioOutcome(base(), step, {
            status: 'failed',
            message: 'no photo was entered (submit-failed)',
            pool: { reserve: ['p2'] },
        });
        expect(failed.poolProgress?.main.reserved).toEqual(['p2']);
        expect(failed.lastError?.message).toBe('m');
    });

    test('leaving the phase drops the runtime pins and keeps what the pool has given out', () => {
        const before = base({ phasePins: { boost: 'a' }, poolProgress: { main: { consumed: ['p1'], reserved: [] } } });
        const stayed = finishScenarioRule(before, {
            ruleId: 'r',
            startState: before,
            gotoPhase: null,
            skippedStep: null,
            at: 300,
            timezone: 'UTC',
        });
        expect(stayed.phasePins).toEqual({ boost: 'a' });
        const left = finishScenarioRule(before, {
            ruleId: 'r',
            startState: before,
            gotoPhase: 'next',
            skippedStep: null,
            at: 300,
            timezone: 'UTC',
        });
        expect(left.phasePins).toBeUndefined();
        expect(left.poolProgress).toEqual({ main: { consumed: ['p1'], reserved: [] } });
    });
});
