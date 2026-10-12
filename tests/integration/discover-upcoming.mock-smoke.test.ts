/**
 * Mock-mode smoke test of upcoming challenges, in a single process over the real settings facade
 * (an in-memory headless store), the real handlers and the mock API: the upcoming mock challenge
 * reaches Discover and the CLI, choosing photos for it saves them per id, a join pass followed by
 * cleanup keeps them, it cannot be joined yet, and a fill with the pick-order setting on submits
 * the chosen photos in list order.
 */

import settings = require('../../src/ts/settings');
import loggerModule = require('../../src/ts/logger');
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as apiFactoryModule from '../../src/ts/apiFactory';
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as joinChallengesModule from '../../src/ts/services/joinChallenges';
import type * as discoverChallengesModule from '../../src/ts/services/discoverChallenges';
import type * as openChallengeCacheModule from '../../src/ts/services/openChallengeCache';
import type * as cliJoinModule from '../../src/ts/cli/commands/join';
import type { AndroidHeadlessStore } from '../../src/ts/types/settings';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actionsHandlersModule;
const { getApiStrategy, refreshApi } = require('../../src/ts/apiFactory') as typeof apiFactoryModule;
const { fillChallengeNow } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { runJoinPass } = require('../../src/ts/services/joinChallenges') as typeof joinChallengesModule;
const { clearUpcomingCache } = require('../../src/ts/services/discoverChallenges') as typeof discoverChallengesModule;
const { clearOpenChallenges } = require('../../src/ts/services/openChallengeCache') as typeof openChallengeCacheModule;
const { showDiscover } = require('../../src/ts/cli/commands/join') as typeof cliJoinModule;

const g = globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean; AndroidHeadlessStore?: AndroidHeadlessStore };

// Mock endpoints answer after a simulated delay; give the whole story room.
jest.setTimeout(30000);

const UPCOMING_FREE = '900101';
const UPCOMING_PAID = '900102';
const UPCOMING_LATER = '900103';
const FIRST = 'photo_old_008';
const SECOND = 'photo_pink_flower_001';

const listChallenges = () =>
    invalid<(event: object) => Promise<{ success: boolean; items: Array<{ id: number; status?: string }> }>>(
        buildHandlers()['get-member-challenges'],
    )({});
const override = (id: string) => settings.getChallengeOverride('chosenPhotos', id);

/** Every info line logged: what the CLI printed. */
const printed = () =>
    jest
        .mocked(loggerModule.withCategory)
        .mock.results.flatMap((r) =>
            (r.value as { info: jest.MockedFunction<(m: string) => void> }).info.mock.calls.map(([m]) => String(m)),
        );

beforeEach(() => {
    jest.clearAllMocks();
    g.__GS_HEADLESS__ = true;
    const store: AndroidHeadlessStore & { value: string | null; keys: Record<string, string> } = {
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
    settings.setSetting('mock', true);
    settings.setSetting('token', 'smoke-token');
    refreshApi();
    clearUpcomingCache();
    clearOpenChallenges();
    settings.forgetOpenChallengeIds();
    // The main process's own active list: cleanup only prunes what that list also lacks.
    settings.rememberChallengeTitles([{ id: '999', title: 'Elsewhere' }]);
});

afterEach(() => {
    delete g.__GS_HEADLESS__;
    delete g.AndroidHeadlessStore;
    settings.rememberChallengeTitles([]);
    settings.forgetOpenChallengeIds();
});

const joinPass = () => {
    const strategy = getApiStrategy();
    return runJoinPass('smoke-token', Date.now(), {
        getMemberChallenges: strategy.getMemberChallenges,
        getBankroll: strategy.getBankroll,
        coinsUnlock: jest.fn(async () => ({ ok: false, raw: null })),
        submitToChallenge: strategy.submitToChallenge,
        getEligiblePhotos: strategy.getEligiblePhotos,
        getEligiblePhotosWalk: strategy.getEligiblePhotosWalk,
        joinStateStore: null,
    });
};

test('the upcoming mock challenges reach Discover: those inside the 24 h window, behind the open ones', async () => {
    const result = await listChallenges();
    expect(result.success).toBe(true);
    expect(result.items.map((c) => [String(c.id), c.status])).toEqual([
        ['900001', undefined],
        ['900002', undefined],
        ['900003', undefined],
        ['900004', undefined],
        ['900005', undefined],
        [UPCOMING_FREE, 'upcoming'],
        [UPCOMING_PAID, 'upcoming'],
    ]);
    // The window is a setting: wider shows the later one, 0 shows none.
    clearUpcomingCache();
    settings.setGlobalDefault('discoverUpcomingHours', 100);
    expect((await listChallenges()).items.map((c) => String(c.id))).toContain(UPCOMING_LATER);
    clearUpcomingCache();
    settings.setGlobalDefault('discoverUpcomingHours', 0);
    expect((await listChallenges()).items.every((c) => c.status === undefined)).toBe(true);
});

test('the CLI lists them as "starts in …" and says how to choose their photos', async () => {
    await showDiscover();
    const lines = printed();
    expect(lines).toContain('=== Open and upcoming challenges ===');
    expect(
        lines.some(
            (l) => l.startsWith(`  • [${UPCOMING_FREE}] Mock Upcoming Free Challenge`) && l.includes('starts in'),
        ),
    ).toBe(true);
    expect(
        lines.some((l) => l.startsWith(`  • [${UPCOMING_PAID}]`) && l.includes('150 coins') && l.includes('starts in')),
    ).toBe(true);
    expect(lines.some((l) => l.includes(UPCOMING_LATER))).toBe(false);
    expect(lines).toContain('  list-photos --challenge=<id>');
    expect(lines.some((l) => l.startsWith('  • [900001] Mock Free Challenge') && !l.includes('starts in'))).toBe(true);
});

test('chosen photos are saved for an upcoming id and survive a join pass and cleanup — with the window at 0 too', async () => {
    const annotations = invalid<
        (event: object, ids: string[]) => Promise<{ annotations: Record<string, { chosenOwn: string[] }> }>
    >(buildHandlers()['get-open-chosen-annotations']);
    await listChallenges();
    expect(settings.setChallengeOverride('chosenPhotos', UPCOMING_FREE, [FIRST, SECOND])).toBe(true);
    expect(settings.setChallengeOverride('chosenPhotosInOrder', UPCOMING_FREE, true)).toBe(true);
    settings.setChallengeOverride('chosenPhotos', '900555', ['stale']);
    // The row reads it back, through the merged list.
    expect((await annotations({}, [UPCOMING_FREE])).annotations[UPCOMING_FREE].chosenOwn).toEqual([FIRST, SECOND]);

    settings.setSetting('autoJoin', true);
    await joinPass();
    expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
    expect(override(UPCOMING_FREE)).toEqual([FIRST, SECOND]);
    expect(settings.getChallengeOverride('chosenPhotosInOrder', UPCOMING_FREE)).toBe(true);
    // A challenge in neither list is stale and goes.
    expect(override('900555')).toBeNull();

    // Window 0: Discover still records every upcoming id, so nothing is pruned.
    clearUpcomingCache();
    settings.setGlobalDefault('discoverUpcomingHours', 0);
    await listChallenges();
    await joinPass();
    settings.cleanupStaleChallengeSetting([]);
    expect(override(UPCOMING_FREE)).toEqual([FIRST, SECOND]);
});

test('after a restart (no lists known) a join pass and cleanup before any Discover fetch prune nothing', async () => {
    settings.setChallengeOverride('chosenPhotos', UPCOMING_FREE, [FIRST]);
    settings.setSetting('autoJoin', true);
    await joinPass();
    expect(settings.getUpcomingChallengeIds()).toBeNull();
    settings.cleanupStaleChallengeSetting([]);
    expect(override(UPCOMING_FREE)).toEqual([FIRST]);
});

test('with the first upcoming fetch failing, nothing is recorded and cleanup still prunes nothing', async () => {
    const strategy = getApiStrategy();
    const real = strategy.getMemberChallenges;
    const spy = jest
        .spyOn(strategy, 'getMemberChallenges')
        .mockImplementation(async (token, filter) => (filter === 'upcoming' ? null : real(token, filter)));
    try {
        settings.setChallengeOverride('chosenPhotos', UPCOMING_FREE, [FIRST]);
        const result = await listChallenges();
        // The open list still shows, without the upcoming rows.
        expect(result.items.map((c) => String(c.id))).toEqual(['900001', '900002', '900003', '900004', '900005']);
        expect(settings.getUpcomingChallengeIds()).toBeNull();
        settings.setSetting('autoJoin', true);
        await joinPass();
        settings.cleanupStaleChallengeSetting([]);
        expect(override(UPCOMING_FREE)).toEqual([FIRST]);
    } finally {
        spy.mockRestore();
    }
});

test('an upcoming challenge cannot be joined yet, nothing is spent, and the open ones still can', async () => {
    const join = invalid<(event: object, id: number, spend: boolean) => Promise<{ success: boolean; status: string }>>(
        buildHandlers()['join-challenge'],
    );
    expect(await join({}, Number(UPCOMING_PAID), true)).toEqual(
        expect.objectContaining({ success: false, status: 'not-started' }),
    );
    expect(await join({}, Number(UPCOMING_FREE), false)).toEqual(
        expect.objectContaining({ success: false, status: 'not-started' }),
    );
    expect(await join({}, 900001, false)).toEqual(expect.objectContaining({ success: true, status: 'joined' }));
});

test('a fill with the pick-order setting on submits the chosen photos in list order', async () => {
    const strategy = getApiStrategy();
    const challenge = invalid<Challenge>({
        id: Number(UPCOMING_FREE),
        title: 'Pink Flowers',
        url: 'pink-flowers1',
        max_photo_submits: 4,
        close_time: Math.floor(Date.now() / 1000) + 3600,
        member: { ranking: { entries: [] } },
    });
    settings.setChallengeOverride('chosenPhotos', UPCOMING_FREE, [FIRST, SECOND]);
    const submit = async (inOrder: boolean) => {
        settings.setChallengeOverride('chosenPhotosInOrder', UPCOMING_FREE, inOrder);
        const submitToChallenge = jest.fn(strategy.submitToChallenge);
        await fillChallengeNow(challenge, 'smoke-token', 'all', {
            settings,
            logger: loggerModule,
            getEligiblePhotos: strategy.getEligiblePhotos,
            getEligiblePhotosWalk: strategy.getEligiblePhotosWalk,
            getImageData: strategy.getImageData,
            submitToChallenge,
            searchTagAutocomplete: strategy.searchTagAutocomplete,
            getCurrentMemberProfile: strategy.getCurrentMemberProfile,
        });
        return submitToChallenge.mock.calls.map(([, ids]) => ids);
    };
    // In order: the list's first photo goes first, though the scorer prefers the pink flower.
    const [ordered] = await submit(true);
    expect(ordered.slice(0, 2)).toEqual([FIRST, SECOND]);
    // Off: the scorer orders the chosen photos, and the pink one is first.
    const [ranked] = await submit(false);
    expect(ranked[0]).toBe(SECOND);
});
