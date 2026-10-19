/**
 * suggestFillPhotos: the pick half of a scheduled fill, answered as a ranking and submitting nothing — Submit
 * Only and the chosen photos, the tag settings, entered photos removed before scoring, its own photo-stats
 * budget, and the side effects it must never have.
 */

import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
import type * as verifyModule from '../../src/ts/services/autoFill/pipeline/verify';
import type * as photoStatsModule from '../../src/ts/services/photoStats';
import type * as suggestModule from '../../src/ts/services/autoFill/pipeline/suggest';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { FillLogger, FillSettings, RankDeps } from '../../src/ts/types/autoFill';
import type { ImageRecord } from '../../src/ts/types/gurushots';
import type { PickerPhoto } from '../../src/ts/types/photoPicker';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/services/semantic/lexicon', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/semantic/lexicon')>(
        '../../src/ts/services/semantic/lexicon',
    ),
}));
// The things a suggestion run must never do are spied on: give each module a spy-able copy.
jest.mock('../../src/ts/services/autoFill/chosenPhotos', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/autoFill/chosenPhotos')>(
        '../../src/ts/services/autoFill/chosenPhotos',
    ),
}));
jest.mock('../../src/ts/services/autoFill/pipeline/verify', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/autoFill/pipeline/verify')>(
        '../../src/ts/services/autoFill/pipeline/verify',
    ),
}));
jest.mock('../../src/ts/services/photoStats', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/photoStats')>('../../src/ts/services/photoStats'),
}));
// photoStats persists its cache through this store; keep it in memory.
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/photo-stats.json',
        initializeAsync: async () => {},
    }),
}));

const { suggestFillPhotos, __resetMemberIdCache } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { SUGGEST_COUNT } = require('../../src/ts/services/autoFill/pipeline/suggest') as typeof suggestModule;
const chosenPhotos = require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
const verify = require('../../src/ts/services/autoFill/pipeline/verify') as typeof verifyModule;
const photoStats = require('../../src/ts/services/photoStats') as typeof photoStatsModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const imageRecord = (votes: number, views: number): ImageRecord => ({ votes, views, achievements: [] });

const photo = (id: string, labels: string[] = ['Pink'], extra: Partial<PickerPhoto> = {}): PickerPhoto => ({
    id,
    labels,
    upload_date: 9000,
    permission: { allowed: true, message: null },
    ...extra,
});

/** Eight on-theme photos, `p0` the newest: the order a tie on theme and popularity falls back to. */
const library = (): PickerPhoto[] =>
    Array.from({ length: 8 }, (_, i) => photo(`p${i}`, ['Pink'], { upload_date: 9000 - i, views: 100 - i }));

const makeChallenge = (entries: unknown[] = [{ id: 'existing' }]) =>
    buildChallenge({
        id: 'c1',
        title: 'Pink In Nature',
        url: 'pink-in-nature23',
        max_photo_submits: 4,
        member: { ranking: { entries } },
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
    chosen?: string[];
    only?: boolean;
    inOrder?: boolean;
    must?: string[];
    submitWithoutTagMatch?: boolean;
};

const makeSettings = ({
    chosen = [],
    only = false,
    inOrder = false,
    must = [],
    submitWithoutTagMatch = true,
}: SettingsSpec = {}): jest.MockedObject<FillSettings> =>
    invalid({
        getEffectiveSetting: jest.fn((key: string) => {
            switch (key) {
                case 'submitWithoutTagMatch':
                    return submitWithoutTagMatch;
                case 'chosenPhotos':
                    return chosen;
                case 'chosenPhotosOnly':
                    return only;
                case 'chosenPhotosInOrder':
                    return inOrder;
                default:
                    return null;
            }
        }),
        getSetting: jest.fn(() => ''),
        getEffectiveTagSetting: jest.fn((key: string) => (key === 'mustIncludeTags' ? must : [])),
        getEffectiveIgnoreTitleWords: jest.fn(() => null),
    });

/** A themed search (a `search` term) finds the pink photos; the unfiltered read returns all. */
const makeLibrary = (photos: PickerPhoto[]) =>
    jest.fn(async (_id: string | number, _token: string, options: { search?: string } = {}) =>
        options.search
            ? photos.filter((p) => (p.labels ?? []).some((l) => l.toLowerCase() === options.search?.toLowerCase()))
            : photos,
    );

type DepsSpec = {
    settings?: SettingsSpec | null;
    photos?: PickerPhoto[];
    walkItems?: PickerPhoto[];
    getImageData?: RankDeps['getImageData'];
    logger?: FillLogger;
};

const makeDeps = ({
    settings = {},
    photos = library(),
    walkItems = photos,
    getImageData = jest.fn(async () => imageRecord(5, 50)),
    logger = makeLog().logger,
}: DepsSpec = {}) => {
    const rankVisually = jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number, _options?: unknown) =>
        ids.slice(0, want),
    );
    return {
        settings: settings === null ? null : makeSettings(settings),
        logger,
        getEligiblePhotos: makeLibrary(photos),
        getEligiblePhotosWalk: jest.fn(async () => ({ items: walkItems, truncated: false })),
        getImageData,
        getSemanticScores: jest.fn(async () => null),
        rankVisually,
        getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-1', userName: 'u' })),
    } satisfies RankDeps & Record<string, unknown>;
};

const suggestedIds = (result: Awaited<ReturnType<typeof suggestFillPhotos>>) =>
    result.status === 'suggested' ? result.photos.map((p) => p.id) : result.status;

beforeEach(() => {
    chosenPhotos.forgetChosenPhotosMemory();
    __resetMemberIdCache();
    photoStats.__resetForTests();
    photoStats.resetPassState();
    jest.restoreAllMocks();
});

describe('suggestFillPhotos', () => {
    test('answers the top SUGGEST_COUNT photos, best first, with no submitter among the dependencies', async () => {
        const deps = makeDeps();
        const result = await suggestFillPhotos(makeChallenge(), 'tok', deps);
        expect(SUGGEST_COUNT).toBe(5);
        expect(result.status).toBe('suggested');
        expect(suggestedIds(result)).toHaveLength(SUGGEST_COUNT);
        expect(new Set(suggestedIds(result)).size).toBe(SUGGEST_COUNT);
        expect(deps).not.toHaveProperty('submitToChallenge');
    });

    test('answers as many photos as asked for, and fewer when the library holds fewer', async () => {
        expect(suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', makeDeps(), 2))).toHaveLength(2);
        const few = makeDeps({ photos: library().slice(0, 3) });
        expect(suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', few))).toHaveLength(3);
    });

    test('removes entered photos before scoring: five come back when the best-ranked ones are entered', async () => {
        const plain = suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', makeDeps()));
        const top = plain.slice(0, 3) as string[];
        const challenge = makeChallenge([{ id: 'existing' }, ...top.map((id) => ({ id }))]);
        const result = await suggestFillPhotos(challenge, 'tok', makeDeps());
        const ids = suggestedIds(result) as string[];
        expect(ids).toHaveLength(SUGGEST_COUNT);
        expect(ids.filter((id) => top.includes(id))).toEqual([]);
    });

    test('answers fetch-error when the photos cannot be read, naming the challenge and not the error', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger });
        deps.getEligiblePhotos.mockRejectedValue(new Error('network down'));
        const result = await suggestFillPhotos(makeChallenge(), 'tok', deps);
        expect(result).toMatchObject({ status: 'fetch-error' });
        expect(lines.warning.join('\n')).toContain('suggest: failed to fetch eligible photos for [Challenge c1]');
    });

    test('drops an id the visual check answers that is not among the candidates', async () => {
        const deps = makeDeps();
        deps.rankVisually.mockImplementation(async (_c, ids, _e, want) => ['stranger', ...ids.slice(0, want - 1)]);
        const result = await suggestFillPhotos(makeChallenge(), 'tok', deps, 3);
        expect(result.status === 'suggested' && result.photos).toHaveLength(2);
    });

    describe('Submit Only Chosen Photos', () => {
        test('answers no-chosen-entered, without reading the library, when every chosen photo is entered', async () => {
            const deps = makeDeps({ settings: { chosen: ['p1', 'p2'], only: true } });
            const challenge = makeChallenge([{ id: 'p1' }, { id: 'p2' }]);
            expect(await suggestFillPhotos(challenge, 'tok', deps)).toEqual({ status: 'no-chosen-entered' });
            expect(deps.getEligiblePhotos).not.toHaveBeenCalled();
        });

        test('answers no-chosen-unusable when none of the chosen photos can go in', async () => {
            const deps = makeDeps({
                settings: { chosen: ['gone'], only: true },
                photos: [photo('p0'), photo('p1')],
            });
            expect(await suggestFillPhotos(makeChallenge(), 'tok', deps)).toEqual({ status: 'no-chosen-unusable' });
        });

        test('answers only the chosen photos that are not entered yet', async () => {
            const deps = makeDeps({ settings: { chosen: ['p5', 'p6', 'p7'], only: true } });
            const challenge = makeChallenge([{ id: 'p6' }]);
            const ids = suggestedIds(await suggestFillPhotos(challenge, 'tok', deps)) as string[];
            expect([...ids].sort()).toEqual(['p5', 'p7']);
        });

        test('with it off the chosen photos only rank first, and the rest fill the list', async () => {
            const deps = makeDeps({ settings: { chosen: ['p7'] } });
            const ids = suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', deps)) as string[];
            expect(ids[0]).toBe('p7');
            expect(ids).toHaveLength(SUGGEST_COUNT);
        });

        test('goes by the list’s own order when In Order is on', async () => {
            const deps = makeDeps({ settings: { chosen: ['p6', 'p2', 'p4'], inOrder: true, only: true } });
            expect(suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', deps))).toEqual(['p6', 'p2', 'p4']);
        });

        test('looks up a chosen photo the themed search missed, in the library walk', async () => {
            const deps = makeDeps({
                settings: { chosen: ['car'], only: true },
                photos: library(),
                walkItems: [...library(), photo('car', ['Car'])],
            });
            expect(suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', deps))).toEqual(['car']);
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        });

        const withCar = () =>
            makeDeps({
                settings: { chosen: ['car'], only: true },
                photos: library(),
                walkItems: [...library(), photo('car', ['Car'])],
            });

        test('reads swap eligibility, in the candidate fetch and in the chosen-photo walk, when asked to', async () => {
            const deps = withCar();
            await suggestFillPhotos(makeChallenge(), 'tok', deps, undefined, { usage: 'swap' });
            expect(deps.getEligiblePhotos).toHaveBeenCalledWith(
                expect.anything(),
                'tok',
                expect.objectContaining({ usage: 'swap' }),
            );
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledWith(
                expect.anything(),
                'tok',
                expect.objectContaining({ usage: 'swap' }),
            );
        });

        test('reads submit eligibility by default', async () => {
            const deps = withCar();
            await suggestFillPhotos(makeChallenge(), 'tok', deps);
            expect(deps.getEligiblePhotos).not.toHaveBeenCalledWith(
                expect.anything(),
                'tok',
                expect.objectContaining({ usage: 'swap' }),
            );
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledWith(
                expect.anything(),
                'tok',
                expect.objectContaining({ usage: 'submit' }),
            );
        });
    });

    describe('tag settings', () => {
        test('are read from deps.settings for the challenge', async () => {
            const deps = makeDeps({ settings: { must: ['pink'] } });
            const challenge = makeChallenge();
            await suggestFillPhotos(challenge, 'tok', deps);
            const settings = deps.settings as jest.MockedObject<FillSettings>;
            expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('mustIncludeTags', challenge);
            expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('shouldIncludeTags', challenge);
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('submitWithoutTagMatch', 'c1');
        });

        test('are skipped without settings: no filter applies', async () => {
            const deps = makeDeps({ settings: null });
            expect(suggestedIds(await suggestFillPhotos(makeChallenge(), 'tok', deps))).toHaveLength(SUGGEST_COUNT);
        });

        test('answer no-match when Must Include is active, photos were considered and none matched', async () => {
            const deps = makeDeps({
                settings: { must: ['Dogs'], submitWithoutTagMatch: false },
                photos: [photo('p0', ['Cats']), photo('p1', ['Cats'])],
            });
            expect(await suggestFillPhotos(makeChallenge(), 'tok', deps)).toEqual({ status: 'no-match' });
        });

        test('answer no-eligible when the library holds nothing, Must Include or not', async () => {
            for (const must of [[], ['Dogs']]) {
                const deps = makeDeps({ settings: { must, submitWithoutTagMatch: false }, photos: [] });
                expect(await suggestFillPhotos(makeChallenge(), 'tok', deps)).toEqual({ status: 'no-eligible' });
            }
        });

        test('answer no-eligible, not no-match, when only entered photos were left to consider', async () => {
            const deps = makeDeps({
                settings: { must: ['Dogs'], submitWithoutTagMatch: false },
                photos: [photo('p0', ['Cats'])],
            });
            expect(await suggestFillPhotos(makeChallenge([{ id: 'p0' }]), 'tok', deps)).toEqual({
                status: 'no-eligible',
            });
        });

        test('answer no-eligible when Must Include is off and no photo is allowed for the challenge', async () => {
            const blocked = [photo('p0', ['Pink'], { permission: { allowed: false, message: 'used' } })];
            const deps = makeDeps({ settings: { submitWithoutTagMatch: false }, photos: blocked });
            expect(await suggestFillPhotos(makeChallenge(), 'tok', deps)).toEqual({ status: 'no-eligible' });
        });
    });

    describe('what it must never do', () => {
        test('leaves the entry ledger, the skip and refusal memory and the uncertain-subject record alone', async () => {
            const clearChosenSkip = jest.spyOn(chosenPhotos, 'clearChosenSkip');
            const logChosenSkipOnce = jest.spyOn(chosenPhotos, 'logChosenSkipOnce');
            const refuseRememberedChosen = jest.spyOn(chosenPhotos, 'refuseRememberedChosen');
            const recordUncertainSubmission = jest.spyOn(verify, 'recordUncertainSubmission');
            const resetPassState = jest.spyOn(photoStats, 'resetPassState');
            const deps = makeDeps({ settings: { chosen: ['p3'], only: true } });
            // The same challenge, once with a usable chosen list and once with nothing usable or left.
            await suggestFillPhotos(makeChallenge(), 'tok', deps);
            await suggestFillPhotos(makeChallenge([{ id: 'p3' }]), 'tok', deps);
            await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ settings: { chosen: ['gone'], only: true } }));
            for (const spy of [
                clearChosenSkip,
                logChosenSkipOnce,
                refuseRememberedChosen,
                recordUncertainSubmission,
                resetPassState,
            ]) {
                expect(spy).not.toHaveBeenCalled();
            }
            expect(deps).not.toHaveProperty('submitToChallenge');
            expect(deps).not.toHaveProperty('entryAges');
        });

        test('logs lines that name the challenge and counts, never a photo id', async () => {
            const { logger, lines } = makeLog();
            await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ logger, settings: { chosen: ['p3'] } }));
            await suggestFillPhotos(
                makeChallenge([{ id: 'p3' }]),
                'tok',
                makeDeps({ logger, settings: { chosen: ['p3'], only: true } }),
            );
            await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ logger, photos: [] }));
            const suggestLines = [...lines.info, ...lines.warning].filter((line) => line.startsWith('suggest:'));
            expect(suggestLines).toEqual(
                expect.arrayContaining([
                    'suggest: ranked 5 photos for [Challenge c1]',
                    'suggest: every chosen photo is already entered in [Challenge c1], and Submit Only is on',
                    'suggest: no eligible photos for [Challenge c1]',
                ]),
            );
            for (const line of suggestLines) expect(line).not.toMatch(/\bp\d\b/);
        });

        test('logs when Submit Only leaves nothing usable, and when Must Include matched nothing', async () => {
            const { logger, lines } = makeLog();
            await suggestFillPhotos(
                makeChallenge(),
                'tok',
                makeDeps({ logger, settings: { chosen: ['gone'], only: true } }),
            );
            await suggestFillPhotos(
                makeChallenge(),
                'tok',
                makeDeps({
                    logger,
                    settings: { must: ['Dogs'], submitWithoutTagMatch: false },
                    photos: [photo('p0', ['Cats'])],
                }),
            );
            expect(lines.info).toEqual(
                expect.arrayContaining([
                    'suggest: none of the chosen photos can be submitted to [Challenge c1], and Submit Only is on',
                    'suggest: no photos matched the Must Include Tags for [Challenge c1]',
                ]),
            );
        });
    });

    describe('its own photo-stats budget', () => {
        test('looks stats up for the contested photos and reports statsLimited false when it got them all', async () => {
            const getImageData = jest.fn(async () => imageRecord(5, 50));
            const result = await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ getImageData }));
            expect(getImageData).toHaveBeenCalled();
            expect(result).toMatchObject({ status: 'suggested', statsLimited: false });
        });

        test('reports statsLimited false when a full fill’s worth of lookups all succeed', async () => {
            const many = Array.from({ length: 30 }, (_, i) => photo(`q${i}`, ['Pink'], { views: 100 - i }));
            const getImageData = jest.fn(async () => imageRecord(5, 50));
            const result = await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ photos: many, getImageData }));
            expect(getImageData).toHaveBeenCalledTimes(photoStats.MAX_ENRICH_PER_FILL);
            expect(result).toMatchObject({ status: 'suggested', statsLimited: false });
        });

        test('reports statsLimited when its lookups keep failing, without tripping the pass’s breaker', async () => {
            const failing = jest.fn(async () => null);
            const { logger, lines } = makeLog();
            const result = await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ getImageData: failing, logger }));
            expect(result).toMatchObject({ status: 'suggested', statsLimited: true });
            // The voting pass's own budget still has all its requests.
            const working = jest.fn(async () => imageRecord(1, 1));
            await photoStats.enrichCandidates([photo('fresh')], 'tok', { getImageData: working });
            expect(working).toHaveBeenCalledTimes(1);
            expect(lines.warning.filter((m) => m.includes('photo-stats lookups failed'))).toEqual([]);
            expect(lines.info).toContain(
                'suggest: ranked 5 photos for [Challenge c1] (photo-stat lookups were cut short)',
            );
        });

        test('a pass whose breaker is open does not stop a suggestion from looking stats up', async () => {
            const failing = jest.fn(async () => null);
            await photoStats.enrichCandidates(
                Array.from({ length: 10 }, (_, i) => photo(`x${i}`)),
                'tok',
                { getImageData: failing },
            );
            const working = jest.fn(async () => imageRecord(1, 1));
            const result = await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ getImageData: working }));
            expect(working).toHaveBeenCalled();
            expect(result).toMatchObject({ statsLimited: false });
        });

        test('each run takes a fresh budget', async () => {
            const failing = jest.fn(async () => null);
            await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ getImageData: failing }));
            const working = jest.fn(async () => imageRecord(1, 1));
            const result = await suggestFillPhotos(makeChallenge(), 'tok', makeDeps({ getImageData: working }));
            expect(working).toHaveBeenCalled();
            expect(result).toMatchObject({ statsLimited: false });
        });
    });
});
