/**
 * The Boost-pinned submit's pipeline restriction and entry point: an explicit
 * id pool (`onlyIds`) replaces the saved Chosen Photos settings for one pick —
 * the pick is restricted to that id, Submit Only's skip lines are left alone —
 * and submitPinnedEntry maps every attempt outcome to a reason that tells a
 * definitive failure (latched for the Boost window) from a transient one.
 */

import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { FillDeps, FillLogger, FillSettings } from '../../src/ts/types/autoFill';
import type { PickerPhoto } from '../../src/ts/types/photoPicker';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/services/semantic/lexicon', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/semantic/lexicon')>(
        '../../src/ts/services/semantic/lexicon',
    ),
}));
// photoStats persists its cache through this store; keep it in memory.
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/photo-stats-only-ids.json',
        initializeAsync: async () => {},
    }),
}));
// Spied on (never replaced): the pinned submit must leave the Submit Only
// skip lines — their explaining and their clearing — untouched.
jest.mock('../../src/ts/services/autoFill/chosenPhotos', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/autoFill/chosenPhotos')>(
        '../../src/ts/services/autoFill/chosenPhotos',
    ),
}));

const { submitNewEntryForAction, submitPinnedEntry, __resetMemberIdCache } =
    require('../../src/ts/services/autoFill') as typeof autoFillModule;
const chosenPhotos = require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
const { forgetChosenPhotosMemory } = chosenPhotos;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const NOW = 1_000_000;

const photo = (id: string, labels: string[] = ['Pink'], extra: Partial<PickerPhoto> = {}): PickerPhoto => ({
    id,
    labels,
    upload_date: 9000,
    permission: { allowed: true, message: null },
    ...extra,
});

// A due fill: one entry, a 4-slot challenge ten minutes from closing.
const makeChallenge = ({
    entries = [{ id: 'existing' }],
    swaps,
    maxSubmits = 4,
    closeIn = 600,
}: {
    entries?: unknown[];
    swaps?: unknown[];
    maxSubmits?: number;
    closeIn?: number;
} = {}) =>
    buildChallenge({
        id: 'c1',
        title: 'Pink In Nature',
        url: 'pink-in-nature23',
        max_photo_submits: maxSubmits,
        close_time: NOW + closeIn,
        member: { ranking: { entries, swaps } },
    });

const makeLog = () => {
    const lines: Record<'info' | 'warning' | 'success' | 'error' | 'debug', string[]> = {
        info: [],
        warning: [],
        success: [],
        error: [],
        debug: [],
    };
    const cat = {
        info: (m: string) => lines.info.push(m),
        warning: (m: string) => lines.warning.push(m),
        success: (m: string) => lines.success.push(m),
        error: (m: string) => lines.error.push(m),
        debug: (m: string) => lines.debug.push(m),
    };
    const logger = invalid<FillLogger>({
        withCategory: () => cat,
        challengeTag: (c: Parameters<FillLogger['challengeTag']>[0]) =>
            `[Challenge ${c && typeof c === 'object' ? c.id : c}]`,
    });
    return { logger, lines };
};

type SettingsSpec = {
    chosen?: unknown;
    only?: boolean;
    must?: string[];
    submitWithoutTagMatch?: boolean;
};

const makeSettings = ({
    chosen = [],
    only = false,
    must = [],
    submitWithoutTagMatch = true,
}: SettingsSpec = {}): jest.MockedObject<FillSettings> =>
    invalid({
        getEffectiveSetting: jest.fn((key: string) => {
            switch (key) {
                case 'submitWithoutTagMatch':
                    return submitWithoutTagMatch;
                case 'emergencySubmit':
                    return 300;
                case 'chosenPhotos':
                    return chosen;
                case 'chosenPhotosOnly':
                    return only;
                case 'chosenPhotosInOrder':
                    return false;
                default:
                    return null;
            }
        }),
        getEffectiveTagSetting: jest.fn((key: string) => (key === 'mustIncludeTags' ? must : [])),
        getEffectiveIgnoreTitleWords: jest.fn(() => null),
    });

/**
 * A library whose themed search (a `search` term) only finds the pink photos,
 * like the live endpoint's tag search, while the unfiltered read returns all.
 */
const makeLibrary = (library: PickerPhoto[]) =>
    jest.fn(async (_id: string | number, _token: string, options: { search?: string } = {}) =>
        options.search
            ? library.filter((p) => (p.labels ?? []).some((l) => l.toLowerCase() === options.search?.toLowerCase()))
            : library,
    );

const submitOk = () => jest.fn(async () => invalid({ ok: true, raw: { success: true } }));

type DepsSpec = {
    settings?: SettingsSpec;
    library?: PickerPhoto[];
    walkItems?: PickerPhoto[];
    walkTruncated?: boolean;
    logger?: FillLogger;
    extra?: Record<string, unknown>;
};

const makeDeps = ({
    settings = {},
    library = [photo('theme-a'), photo('theme-b')],
    walkItems = library,
    walkTruncated = false,
    logger = makeLog().logger,
    extra = {},
}: DepsSpec = {}) => {
    const deps = {
        settings: makeSettings(settings),
        logger,
        getEligiblePhotos: makeLibrary(library),
        getEligiblePhotosWalk: jest.fn(async () => ({ items: walkItems, truncated: walkTruncated, nextStart: 0 })),
        getSemanticScores: jest.fn(async () => null),
        submitToChallenge: submitOk(),
        rankVisually: jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number) => ids.slice(0, want)),
        ...extra,
    };
    return deps as typeof deps & FillDeps;
};

const submittedIds = (deps: { submitToChallenge: { mock: { calls: unknown[][] } } }) =>
    deps.submitToChallenge.mock.calls.map((c) => c[1] as string[]);

beforeEach(() => {
    forgetChosenPhotosMemory();
    __resetMemberIdCache();
    jest.restoreAllMocks();
});

describe('the onlyIds pool', () => {
    test('picks only the given id, however many candidates the fetch offered', async () => {
        const deps = makeDeps({ library: [photo('theme-a'), photo('theme-b')] });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-b')).toEqual({
            ok: true,
            imageId: 'theme-b',
            reason: 'submitted',
        });
        expect(submittedIds(deps)).toEqual([['theme-b']]);
    });

    test('a pinned photo the themed fetch missed is looked up by the walk and submitted exactly', async () => {
        // The saved list names a photo the fetch DID return; it is ignored all the same.
        const deps = makeDeps({
            library: [photo('theme-a'), photo('theme-b')],
            walkItems: [photo('theme-a'), photo('theme-b'), photo('car', ['Car'])],
            settings: { chosen: ['theme-a'] },
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'car')).toEqual({
            ok: true,
            imageId: 'car',
            reason: 'submitted',
        });
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        expect(submittedIds(deps)).toEqual([['car']]);
    });

    test('the swap filter keeps the pinned id: a photo the challenge swapped out is still picked', async () => {
        // Newest upload wins a tie, so the swapped-out photo would rank best on its own.
        const deps = makeDeps({
            library: [photo('theme-a', ['Pink'], { upload_date: 9500 }), photo('swapped', ['Pink'])],
        });
        const challenge = makeChallenge({ swaps: [{ id: 'swapped' }] });
        expect(await submitPinnedEntry(challenge, 'tok', deps, 'swapped')).toEqual({
            ok: true,
            imageId: 'swapped',
            reason: 'submitted',
        });
        expect(submittedIds(deps)).toEqual([['swapped']]);
    });

    test.each([true, false])(
        'Submit Only %s: the chosen-skip lines are left alone and an empty pool ends as no-pick',
        async (only) => {
            const skipOnce = jest.spyOn(chosenPhotos, 'logChosenSkipOnce');
            const clearSkip = jest.spyOn(chosenPhotos, 'clearChosenSkip');
            const { logger, lines } = makeLog();
            // The pinned photo is not in the library at all; the completed walk says so.
            const deps = makeDeps({
                logger,
                library: [photo('theme-a')],
                walkItems: [],
                settings: { chosen: ['theme-a'], only },
            });
            expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'ghost')).toEqual({
                ok: false,
                imageId: null,
                reason: 'pin-not-found',
            });
            expect(skipOnce).not.toHaveBeenCalled();
            expect(clearSkip).not.toHaveBeenCalled();
            expect(lines.warning).toEqual([]);
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        },
    );

    test('the empty pool logs the pin-specific line, not the generic one', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, library: [photo('theme-a')], walkItems: [] });
        await submitPinnedEntry(makeChallenge(), 'tok', deps, 'ghost');
        expect(
            lines.info.some((m) =>
                m.includes(
                    'fillNew: the photo pinned for Boost (ghost) cannot be submitted — not offered, not allowed here, or filtered out',
                ),
            ),
        ).toBe(true);
        expect(lines.info.some((m) => m.includes('no eligible photos'))).toBe(false);
    });

    test('the generic empty line stays for the picker-chosen fill new', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, library: [] });
        expect(await submitNewEntryForAction(makeChallenge(), 'tok', deps)).toEqual({
            ok: false,
            imageId: null,
            reason: 'no-eligible',
        });
        expect(lines.info).toContain('fillNew: no eligible photos for [Challenge c1]');
    });
});

describe('submitPinnedEntry', () => {
    test('success: the photo goes in and no success line is logged (the orchestrator logs the boost)', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, library: [photo('theme-a')] });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: true,
            imageId: 'theme-a',
            reason: 'submitted',
        });
        expect(lines.success).toEqual([]);
    });

    test('the invalid-challenge guard comes before settings or the API are touched', async () => {
        const settings = makeSettings();
        const getEligiblePhotos = jest.fn();
        const result = await submitPinnedEntry(
            invalid({ id: null }),
            'tok',
            { settings, logger: makeLog().logger, getEligiblePhotos, submitToChallenge: jest.fn() },
            'p1',
        );
        expect(result).toEqual({ ok: false, imageId: null, reason: 'invalid-challenge' });
        expect(settings.getEffectiveTagSetting).not.toHaveBeenCalled();
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('a full challenge is not submitted to', async () => {
        const deps = makeDeps({ library: [photo('theme-a')] });
        const challenge = makeChallenge({
            entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
            maxSubmits: 4,
        });
        expect(await submitPinnedEntry(challenge, 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'no-slots',
        });
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a failed candidate fetch stays transient', async () => {
        const error = new Error('network down');
        const deps = makeDeps({ library: [photo('theme-a')] });
        deps.getEligiblePhotos = jest.fn().mockRejectedValue(error);
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'fetch-error',
        });
    });

    test('a server refusal is definitive', async () => {
        const deps = makeDeps({ library: [photo('theme-a')] });
        deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: { success: false } }));
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'submit-rejected',
        });
    });

    test('a submit that threw is transient', async () => {
        const deps = makeDeps({ library: [photo('theme-a')] });
        deps.submitToChallenge.mockRejectedValue(new Error('timeout'));
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'submit-unanswered',
        });
    });

    test('a challenge that left the active list is not submitted to', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            extra: { getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 'other' }] }) },
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'challenge-gone',
        });
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a live re-read that cannot be trusted stays transient', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            extra: {
                getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 'other' }], pruneUnsafe: true }),
            },
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'theme-a')).toEqual({
            ok: false,
            imageId: null,
            reason: 'data-incomplete',
        });
    });

    test('a photo the walk saw refused here is definitive', async () => {
        const refused = photo('car', ['Car'], { permission: { allowed: false, message: 'used elsewhere' } });
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), refused],
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'car')).toEqual({
            ok: false,
            imageId: null,
            reason: 'pin-refused',
        });
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a completed walk that did not find the photo is definitive', async () => {
        const deps = makeDeps({ library: [photo('theme-a')], walkItems: [photo('theme-a')] });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'car')).toEqual({
            ok: false,
            imageId: null,
            reason: 'pin-not-found',
        });
    });

    test('a photo that was offered but kept out of the pick by a filter is definitive', async () => {
        // Offered by the fetch, then dropped from the pick: not allowed here.
        const deps = makeDeps({
            library: [photo('car', ['Pink'], { permission: { allowed: false, message: 'used elsewhere' } })],
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'car')).toEqual({
            ok: false,
            imageId: null,
            reason: 'pin-filtered',
        });
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });

    test('no walk answer (the walk was cut short) stays transient', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a')],
            walkTruncated: true,
        });
        expect(await submitPinnedEntry(makeChallenge(), 'tok', deps, 'car')).toEqual({
            ok: false,
            imageId: null,
            reason: 'walk-incomplete',
        });
    });
});
