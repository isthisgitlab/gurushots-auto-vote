/**
 * Join with the user's chosen photos, over the REAL picker and candidate fetch
 * (joinChallenges.test.ts stubs them): the chosen photo is the whole shortlist,
 * Submit Only Chosen Photos skips before any coin is spent, a join whose coins
 * are already spent (or that a person asked for) still picks automatically,
 * and an un-joined challenge reads its own per-id override.
 */

jest.mock('../../src/ts/logger', () => {
    const lines: Record<'info' | 'error' | 'debug' | 'success' | 'warning', string[]> = {
        info: [],
        error: [],
        debug: [],
        success: [],
        warning: [],
    };
    const level = {
        info: (m: string) => lines.info.push(m),
        error: (m: string) => lines.error.push(m),
        debug: (m: string) => lines.debug.push(m),
        success: (m: string) => lines.success.push(m),
        warning: (m: string) => lines.warning.push(m),
    };
    return {
        __lines: lines,
        withCategory: jest.fn(() => level),
        challengeTag: (c: { id?: string | number } | null) => `challenge ${c?.id}`,
    };
});
// photoStats persists its cache through this store; keep it in memory.
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/photo-stats.json',
        initializeAsync: async () => {},
    }),
}));
jest.mock('../../src/ts/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/ts/services/visionVerifier', () => ({
    rankVisually: jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number) => ids.slice(0, want)),
}));
jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn(() => undefined),
    getEffectiveTagSetting: jest.fn(() => []),
    getEffectiveIgnoreTitleWords: jest.fn(() => null),
    getChallengeOverride: jest.fn(() => null),
    getSetting: jest.fn(() => ''),
    getTitleRules: jest.fn(() => []),
    getChallengeProfiles: jest.fn(() => ({})),
    resolveRuleSetting: jest.fn(() => null),
    hasRuleJoinOptIn: jest.fn(() => false),
    rememberOpenChallengeIds: jest.fn(),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import loggerModule = require('../../src/ts/logger');
const lines = (loggerModule as unknown as { __lines: Record<string, string[]> }).__lines;
import visionModule = require('../../src/ts/services/visionVerifier');
const vision = jest.mocked(visionModule);
import type * as joinChallengesModule from '../../src/ts/services/joinChallenges';
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { PickerPhoto } from '../../src/ts/types/photoPicker';
import type { RawJsonStore } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';
import type { JoinDeps } from '../../src/ts/services/joinChallenges';
const { performJoin, runJoinPass, joinChallengeSingle, resolveJoinSetting, inFlight } =
    require('../../src/ts/services/joinChallenges') as typeof joinChallengesModule;
const { __resetMemberIdCache } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { __resetChosenPhotos } = require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;

const photo = (id: string, labels: string[]): PickerPhoto => ({
    id,
    labels,
    upload_date: 1000,
    permission: { allowed: true, message: null },
});

// A themed search ("pink") only finds the pink photos; the unfiltered read gets everything.
const makeLibrary = (library: PickerPhoto[]) =>
    jest.fn(async (_id: string | number, _token: string, options: { search?: string } = {}) =>
        options.search
            ? library.filter((p) => (p.labels ?? []).some((l) => l.toLowerCase() === options.search?.toLowerCase()))
            : library,
    );

const eleven = Array.from({ length: 11 }, (_, i) => photo(`auto-${i}`, ['Pink']));
const CAR = photo('car', ['Car']);

const challenge = (id: number | string = 1) => invalid<Challenge>({ id, title: 'Pink Flowers', url: 'pink-flowers1' });

const makeStore = (initial: string | null = null): RawJsonStore => {
    let s = initial;
    return { readRaw: () => s, writeRaw: (d: string) => (s = d) };
};

const makeDeps = (library: PickerPhoto[] = [...eleven, CAR], over: Record<string, unknown> = {}) =>
    invalid<JoinDeps & { joinStateStore: RawJsonStore }>({
        getMemberChallenges: jest.fn(async () => []),
        getBankroll: jest.fn(async () => ({ coins: 1000 })),
        coinsUnlock: jest.fn(async () => ({ ok: true })),
        submitToChallenge: jest.fn(async () => ({ ok: true })),
        getEligiblePhotos: makeLibrary(library.filter((p) => p.id !== 'car')),
        getEligiblePhotosWalk: jest.fn(async () => ({ items: library, truncated: false })),
        getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-1', userName: 'u' })),
        joinStateStore: makeStore(),
        ...over,
    });

/** The settings a join reads, as the facade would resolve them for the candidate. */
const withSettings = (values: Record<string, unknown>) => {
    settings.getEffectiveSetting.mockImplementation((key) => values[key] as never);
    settings.resolveRuleSetting.mockImplementation((key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key] } : null,
    );
};

beforeEach(() => {
    jest.clearAllMocks();
    for (const level of Object.values(lines)) level.length = 0;
    __resetChosenPhotos();
    __resetMemberIdCache();
    inFlight.clear();
    settings.getChallengeOverride.mockReturnValue(null);
    settings.getSetting.mockReturnValue('' as never);
    settings.getEffectiveTagSetting.mockReturnValue([]);
    settings.resolveRuleSetting.mockReturnValue(null);
    vision.rankVisually.mockImplementation(async (_c, ids, _e, want) => ids.slice(0, want));
});

describe('the chosen photo is the join photo', () => {
    test('1 chosen photo + 11 on-theme automatic ones: the chosen photo wins, even against a model that prefers another', async () => {
        withSettings({ chosenPhotos: ['car'], fillWithoutTagMatch: true });
        // Whatever the model is asked, it prefers the LAST id it is given — a top-up photo.
        vision.rankVisually.mockImplementation(async (_c, ids) => [ids[ids.length - 1]]);
        const deps = makeDeps();
        const res = await performJoin(challenge(), 'tok', deps, 0);
        expect(res).toEqual({ status: 'joined', charged: 0, imageId: 'car' });
        expect(deps.submitToChallenge).toHaveBeenCalledWith(1, ['car'], 'tok');
        expect(vision.rankVisually).not.toHaveBeenCalled();
        // The themed fetch missed it, so one lookup of the library found it.
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
    });

    test('several chosen photos: the shortlist is the chosen block alone', async () => {
        withSettings({ chosenPhotos: ['auto-3', 'auto-7'], fillWithoutTagMatch: true });
        const deps = makeDeps();
        await performJoin(challenge(), 'tok', deps, 0);
        expect(vision.rankVisually).toHaveBeenCalledTimes(1);
        expect([...vision.rankVisually.mock.calls[0][1]].sort()).toEqual(['auto-3', 'auto-7']);
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });

    test('a chosen photo that cannot be entered leaves the ordinary pick', async () => {
        withSettings({ chosenPhotos: ['car'], fillWithoutTagMatch: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
        });
        const res = await performJoin(challenge(), 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(res.imageId).toMatch(/^auto-/);
    });

    test('a failed lookup of the chosen photo is logged under join and the join goes on', async () => {
        withSettings({ chosenPhotos: ['car'], fillWithoutTagMatch: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => Promise.reject(new Error('down'))),
        });
        const res = await performJoin(challenge(), 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(lines.debug.some((m) => m.includes('join: could not look for your chosen photos: down'))).toBe(true);
    });

    test('an unreadable photo list is a no-photo skip', async () => {
        withSettings({ chosenPhotos: ['car'] });
        const deps = makeDeps(undefined, { getEligiblePhotos: jest.fn(async () => []) });
        deps.getEligiblePhotosWalk = jest.fn(async () => ({ items: [], truncated: false })) as never;
        const res = await performJoin(challenge(), 'tok', deps, 0);
        expect(res).toEqual({ status: 'skipped-no-photo', charged: 0 });
    });
});

describe('Submit Only Chosen Photos on a join', () => {
    test('nothing usable: skipped before any coin is spent, and explained once', async () => {
        withSettings({ chosenPhotos: ['gone'], chosenPhotosOnly: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
        });
        const first = await performJoin(challenge(), 'tok', deps, 50);
        const second = await performJoin(challenge(), 'tok', deps, 50);
        expect(first).toEqual({ status: 'skipped-no-chosen', charged: 0 });
        expect(second.status).toBe('skipped-no-chosen');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
        expect(lines.warning.filter((m) => m.includes('skipped challenge 1'))).toHaveLength(1);
    });

    test('a usable chosen photo is submitted, and a paid unlock happens only after a photo is picked', async () => {
        withSettings({ chosenPhotos: ['car'], chosenPhotosOnly: true });
        const deps = makeDeps();
        const res = await performJoin(challenge(), 'tok', deps, 50);
        expect(res).toEqual({ status: 'joined', charged: 50, imageId: 'car' });
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        const order = [
            jest.mocked(deps.submitToChallenge).mock.invocationCallOrder[0],
            jest.mocked(deps.coinsUnlock).mock.invocationCallOrder[0],
        ];
        expect(order[1]).toBeLessThan(order[0]);
    });

    test('a join that already unlocked submits an automatic pick — no second coinsUnlock', async () => {
        withSettings({ chosenPhotos: ['gone'], chosenPhotosOnly: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
            joinStateStore: makeStore(JSON.stringify({ '1': { unlockedAt: 1 } })),
        });
        const res = await performJoin(challenge(), 'tok', deps, 50);
        expect(res.status).toBe('joined');
        expect(res.imageId).toMatch(/^auto-/);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('a manual join auto-picks', async () => {
        withSettings({ chosenPhotos: ['gone'], chosenPhotosOnly: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }]),
        });
        const res = await joinChallengeSingle(1, 'tok', deps);
        expect(res.status).toBe('joined');
        expect(res.imageId).toMatch(/^auto-/);
    });

    test('the automatic pass reports the skip as its own status', async () => {
        withSettings({ autoJoin: true, chosenPhotos: ['gone'], chosenPhotosOnly: true, autoJoinMaxCoins: 0 });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }]),
        });
        const pass = await runJoinPass('tok', Date.now(), deps);
        expect(pass.results).toEqual([{ id: 1, status: 'skipped-no-chosen' }]);
        // The open list was remembered so cleanup spares chosen-photo entries for it.
        expect(settings.rememberOpenChallengeIds).toHaveBeenCalledWith([1]);
    });

    test('only candidates that have an id are remembered as open', async () => {
        withSettings({ autoJoin: true, chosenPhotos: ['gone'], chosenPhotosOnly: true });
        const deps = makeDeps(eleven, {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: eleven, truncated: false })),
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }, { title: 'no id' }, null]),
        });
        await runJoinPass('tok', Date.now(), deps);
        expect(settings.rememberOpenChallengeIds).toHaveBeenCalledWith([1]);
    });

    test('an unreadable open list is not remembered', async () => {
        withSettings({ autoJoin: true });
        const deps = makeDeps(undefined, { getMemberChallenges: jest.fn(async () => invalid(null)) });
        await runJoinPass('tok', Date.now(), deps);
        expect(settings.rememberOpenChallengeIds).not.toHaveBeenCalled();
    });
});

describe('the list belongs to one account', () => {
    test('another account ignores it on a join, with one line', async () => {
        withSettings({ chosenPhotos: ['car'], chosenPhotosOnly: true });
        settings.getSetting.mockReturnValue('member-2' as never);
        const deps = makeDeps();
        const res = await performJoin(challenge(), 'tok', deps, 0);
        // Ignored, so Only has nothing to enforce.
        expect(res.status).toBe('joined');
        expect(res.imageId).not.toBe('car');
        expect(lines.warning.filter((m) => m.includes('saved while another account was signed in'))).toHaveLength(1);
    });
});

describe("resolveJoinSetting reads the candidate's own override for the chosen keys only", () => {
    test('a per-id override wins, including an explicit empty list and an off flag', () => {
        settings.getChallengeOverride.mockImplementation(
            ((key: string) => ({ chosenPhotos: [], chosenPhotosOnly: false })[key] ?? null) as never,
        );
        withSettings({ chosenPhotos: ['from-rule'], chosenPhotosOnly: true });
        expect(resolveJoinSetting('chosenPhotos', challenge(7))).toEqual([]);
        expect(resolveJoinSetting('chosenPhotosOnly', challenge(7))).toBe(false);
        expect(settings.getChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '7');
    });

    test('without an override it falls through to the rules and the global value', () => {
        withSettings({ chosenPhotos: ['from-rule'] });
        expect(resolveJoinSetting('chosenPhotos', challenge(7))).toEqual(['from-rule']);
        settings.resolveRuleSetting.mockReturnValue(null);
        settings.getEffectiveSetting.mockReturnValue(['global'] as never);
        expect(resolveJoinSetting('chosenPhotos', challenge(7))).toEqual(['global']);
    });

    test('every other key resolves as before and never reads the override layer', () => {
        settings.getChallengeOverride.mockReturnValue('override' as never);
        withSettings({ autoJoinMaxCoins: 42 });
        expect(resolveJoinSetting('autoJoinMaxCoins', challenge(7))).toBe(42);
        expect(settings.getChallengeOverride).not.toHaveBeenCalled();
    });

    test('a candidate without an id has no override layer', () => {
        withSettings({ chosenPhotos: ['from-rule'] });
        expect(resolveJoinSetting('chosenPhotos', invalid({ title: 'x' }))).toEqual(['from-rule']);
        expect(settings.getChallengeOverride).not.toHaveBeenCalled();
    });
});
