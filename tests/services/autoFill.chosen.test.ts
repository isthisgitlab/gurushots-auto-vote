/**
 * The user's chosen photos through every fill path: they rank first, a chosen
 * photo the themed fetch missed is looked up once (and remembered), Submit Only
 * Chosen Photos skips a challenge it cannot serve — except for manual fills and
 * emergency fill — and the emergency stand-down check agrees with the runner.
 */

import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
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
        getFilePath: () => '/tmp/photo-stats.json',
        initializeAsync: async () => {},
    }),
}));

const {
    maybeAutoFillChallenge,
    maybeEmergencyFillChallenge,
    evaluateEmergencyFill,
    fillChallengeNow,
    submitNewEntryForAction,
    reflectNewEntry,
    __resetMemberIdCache,
} = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { __resetChosenPhotos, resolveMissingChosen, recallChosenPhotos, logChosenSkipOnce } =
    require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;

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
    maxSubmits = 4,
    closeIn = 600,
    title = 'Pink In Nature',
}: { entries?: unknown[]; maxSubmits?: number; closeIn?: number; title?: string } = {}) =>
    buildChallenge({
        id: 'c1',
        title,
        url: 'pink-in-nature23',
        max_photo_submits: maxSubmits,
        close_time: NOW + closeIn,
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
    autoFill?: boolean;
    chosen?: unknown;
    only?: boolean;
    savedBy?: unknown;
    must?: string[];
    fillWithoutTagMatch?: boolean;
    emergencyFill?: number;
};

const makeSettings = ({
    autoFill = true,
    chosen = [],
    only = false,
    savedBy = '',
    must = [],
    fillWithoutTagMatch = true,
    emergencyFill = 300,
}: SettingsSpec = {}): jest.MockedObject<FillSettings> =>
    invalid({
        getEffectiveSetting: jest.fn((key: string) => {
            switch (key) {
                case 'autoFill':
                    return autoFill;
                case 'autoFillSchedule':
                    return [
                        { count: 2, seconds: 1800 },
                        { count: 3, seconds: 1200 },
                        { count: 4, seconds: 600 },
                    ];
                case 'fillWithoutTagMatch':
                    return fillWithoutTagMatch;
                case 'emergencyFill':
                    return emergencyFill;
                case 'chosenPhotos':
                    return chosen;
                case 'chosenPhotosOnly':
                    return only;
                default:
                    return null;
            }
        }),
        getSetting: jest.fn((key: string) => (key === 'chosenPhotosMemberId' ? savedBy : undefined)),
        getEffectiveTagSetting: jest.fn((key: string) => (key === 'mustIncludeTags' ? must : [])),
        getEffectiveIgnoreTitleWords: jest.fn(() => null),
    });

/**
 * A library whose themed search (a `search` term) only finds the pink photos,
 * like the live endpoint's tag search, while the unfiltered read returns all.
 */
const makeLibrary = (library: PickerPhoto[]) =>
    jest.fn(async (_id: string | number, _token: string, options: { search?: string; paginate?: boolean } = {}) =>
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
    member?: string | null;
    logger?: FillLogger;
    extra?: Record<string, unknown>;
};

const makeDeps = ({
    settings = {},
    library = [photo('theme-a'), photo('theme-b')],
    walkItems = library,
    walkTruncated = false,
    member = 'member-1',
    logger = makeLog().logger,
    extra = {},
}: DepsSpec = {}) => {
    const submitToChallenge = submitOk();
    const getEligiblePhotosWalk = jest.fn(async () => ({ items: walkItems, truncated: walkTruncated }));
    const rankVisually = jest.fn(
        async (
            _c: unknown,
            ids: string[],
            _e: unknown,
            want: number,
            _options?: { onVisualEvidence?: (accepted: Set<string>) => void },
        ) => ids.slice(0, want),
    );
    const deps = {
        settings: makeSettings(settings),
        logger,
        getEligiblePhotos: makeLibrary(library),
        getEligiblePhotosWalk,
        getSemanticScores: jest.fn(async () => null),
        submitToChallenge,
        rankVisually,
        getCurrentMemberProfile: member === null ? undefined : jest.fn(async () => ({ id: member, userName: 'u' })),
        ...extra,
    };
    return deps as typeof deps & FillDeps;
};

const submittedIds = (deps: { submitToChallenge: { mock: { calls: unknown[][] } } }) =>
    deps.submitToChallenge.mock.calls.map((c) => c[1] as string[]);

beforeEach(() => {
    __resetChosenPhotos();
    __resetMemberIdCache();
    jest.restoreAllMocks();
});

describe('chosen photos rank first', () => {
    test('a chosen off-theme photo is submitted ahead of better matches, and the log says who chose it', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({
            logger,
            library: [photo('theme-a'), photo('theme-b'), photo('car', ['Car'])],
            settings: { chosen: ['car'] },
        });
        // The themed search never returns it: it is found by the library walk.
        deps.getEligiblePhotos = makeLibrary([photo('theme-a'), photo('theme-b')]);
        deps.getEligiblePhotosWalk.mockResolvedValue({
            items: [photo('theme-a'), photo('theme-b'), photo('car', ['Car'])],
            truncated: false,
        });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['car']]);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        expect(lines.info.some((m) => m.includes('submitted photo car (chosen by you) selection details'))).toBe(true);
        expect(lines.info.some((m) => /looked for your chosen photos.*1 found, 0 not allowed/.test(m))).toBe(true);
    });

    test('a chosen photo already in the themed fetch needs no extra lookup', async () => {
        const deps = makeDeps({ settings: { chosen: ['theme-b'] } });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-b']]);
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });

    test('the visual re-rank only chooses between chosen photos, and a block it cannot reorder is left alone', async () => {
        const deps = makeDeps({
            library: [photo('theme-a'), photo('theme-b'), photo('theme-c'), photo('theme-d')],
            settings: { chosen: ['theme-b', 'theme-c'] },
        });
        // The model prefers the LAST candidate it is given.
        deps.rankVisually.mockImplementation(async (_c, ids) => [ids[ids.length - 1]]);
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(deps.rankVisually).toHaveBeenCalledTimes(1);
        const shortlist = deps.rankVisually.mock.calls[0][1];
        expect(shortlist.sort()).toEqual(['theme-b', 'theme-c']);
        expect(['theme-b', 'theme-c']).toContain(submittedIds(deps)[0][0]);

        // One chosen photo for one slot: nothing to choose between, no model run —
        // even though the model would have preferred a top-up photo.
        const single = makeDeps({
            library: [photo('theme-a'), photo('theme-b'), photo('theme-c')],
            settings: { chosen: ['theme-b'] },
        });
        single.rankVisually.mockImplementation(async (_c, ids) => [ids[ids.length - 1]]);
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, single);
        expect(single.rankVisually).not.toHaveBeenCalled();
        expect(submittedIds(single)).toEqual([['theme-b']]);
    });

    test('visual evidence from the blocks is combined', async () => {
        const deps = makeDeps({
            library: [photo('theme-a'), photo('theme-b'), photo('theme-c')],
            settings: { chosen: ['theme-b', 'theme-c'] },
            extra: { entryAges: createMemoryEntryAgeLedger() },
        });
        deps.rankVisually.mockImplementation(async (_c, ids, _e, want, options) => {
            options?.onVisualEvidence?.(new Set(['theme-c']));
            return ids.slice(0, want);
        });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(deps.rankVisually).toHaveBeenCalledTimes(1);
    });

    test('a chosen photo is never marked uncertain, however off-theme it is', async () => {
        for (const [chosen, uncertain] of [
            [['car'], false],
            [[], true],
        ] as const) {
            __resetChosenPhotos();
            const ledger = createMemoryEntryAgeLedger();
            const challenge = makeChallenge({ title: 'Dogs' });
            const deps = makeDeps({
                library: [photo('car', ['Car'])],
                settings: { chosen: [...chosen] },
                extra: { entryAges: ledger },
            });
            // Dogs: the title search finds nothing, so the unfiltered read supplies the library.
            expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
            expect(ledger.isUncertain(challenge.id, 'car')).toBe(uncertain);
        }
    });

    test('a failed submit forgets what the lookup remembered — for that challenge only', async () => {
        const { logger } = makeLog();
        const other = buildChallenge({ id: 'c2', member: { ranking: { entries: [] } } });
        await resolveMissingChosen({
            challenge: other,
            token: 'tok',
            ids: ['car'],
            eligible: [],
            wantCount: 1,
            allowWalk: true,
            deps: {
                getEligiblePhotosWalk: jest.fn(async () => ({ items: [photo('car', ['Car'])], truncated: false })),
                logger,
            },
            label: 'autoFill',
        });
        const full = [photo('theme-a'), photo('car', ['Car'])];
        const deps = makeDeps({ library: [photo('theme-a')], walkItems: full, settings: { chosen: ['car'] } });
        deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: { success: false } }));
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('error');
        expect(recallChosenPhotos(makeChallenge(), ['car'])).toEqual([]);
        expect(recallChosenPhotos(other, ['car']).map((p) => p.id)).toEqual(['car']);
        deps.submitToChallenge.mockRejectedValue(new Error('boom'));
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('error');
        // Each attempt walked again: nothing was remembered across the failures.
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });
});

describe('looking for a chosen photo the themed fetch missed', () => {
    const car = photo('car', ['Car']);

    test('the lookup is remembered: not repeated within the memo, repeated once the entry count changes', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a')], // the chosen photo is not in the library at all
            settings: { chosen: ['car'], only: true },
        });
        const challenge = makeChallenge();
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('skipped');
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('skipped');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);

        // An entry was added elsewhere: the answer may have changed.
        reflectNewEntry(challenge, 'someone');
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('the memo expires after its lifetime', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
        const deps = makeDeps({ library: [photo('theme-a')], settings: { chosen: ['car'], only: true } });
        const challenge = makeChallenge();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        clock.mockReturnValue(5_000_000 + 31 * 60_000);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('a walk that was cut short never records "not found"; it is only retried after a pause', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a')],
            walkTruncated: true,
            settings: { chosen: ['car'], only: true },
        });
        const challenge = makeChallenge();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        // Unresolved, but not walked again straight away.
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(5_000_000 + 6 * 60_000);
        // The photo turns up once the walk reaches it.
        deps.getEligiblePhotosWalk.mockResolvedValue({ items: [photo('theme-a'), car], truncated: true });
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
        expect(submittedIds(deps)).toEqual([['car']]);
    });

    test('a chosen photo the server refuses is remembered as refused and never submitted', async () => {
        const refused = { ...car, permission: { allowed: false, message: 'used elsewhere' } };
        const { logger, lines } = makeLog();
        const deps = makeDeps({
            logger,
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), refused],
            settings: { chosen: ['car'] },
        });
        const challenge = makeChallenge();
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-a']]);
        expect(lines.info.some((m) => m.includes('0 found, 1 not allowed here'))).toBe(true);
    });

    test('no lookup when the fetch already read the whole library, or when the dependency is absent', async () => {
        // Nothing themed matches, so the fetch falls back to the unfiltered walk itself.
        const deps = makeDeps({ library: [photo('theme-a')], settings: { chosen: ['car'] } });
        deps.getEligiblePhotos = jest.fn(async (_id, _token, options = {}) =>
            options.search ? [] : [photo('theme-a', ['Rock'])],
        );
        await maybeAutoFillChallenge(makeChallenge({ title: 'Dogs' }), 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();

        const without = makeDeps({ settings: { chosen: ['car'] } });
        delete (without as { getEligiblePhotosWalk?: unknown }).getEligiblePhotosWalk;
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, without)).toBe('submitted');
        expect(submittedIds(without)).toEqual([['theme-a']]);
    });

    test('a walk that throws is logged and the fill carries on without the chosen photo', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, library: [photo('theme-a')], settings: { chosen: ['car'] } });
        deps.getEligiblePhotosWalk.mockRejectedValue(new Error('network down'));
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(lines.debug.some((m) => m.includes('could not look for your chosen photos: network down'))).toBe(true);
    });

    test('a walk that rejects with nothing is still reported', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, library: [photo('theme-a')], settings: { chosen: ['car'] } });
        deps.getEligiblePhotosWalk.mockRejectedValue(null);
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(lines.debug.some((m) => m.endsWith('could not look for your chosen photos: null'))).toBe(true);
    });

    test('the memo and the skip log are bounded', async () => {
        const { logger } = makeLog();
        const walkDeps = {
            getEligiblePhotosWalk: jest.fn(async () => ({ items: [], truncated: false })),
            logger,
        };
        // More challenges than the memo holds: the oldest answers are dropped, never an error.
        for (let i = 0; i < 70; i++) {
            const challenge = buildChallenge({ id: `m${i}`, member: { ranking: { entries: [] } } });
            await resolveMissingChosen({
                challenge,
                token: 'tok',
                ids: ['car'],
                eligible: [],
                wantCount: 1,
                allowWalk: true,
                deps: walkDeps,
                label: 'autoFill',
            });
        }
        expect(walkDeps.getEligiblePhotosWalk).toHaveBeenCalledTimes(70);
        for (let i = 0; i < 70; i++) {
            logChosenSkipOnce(logger, buildChallenge({ id: `s${i}` }), 'autoFill', 'none-usable');
        }
        const warnings: string[] = [];
        const spy = invalid<FillLogger>({
            withCategory: () => ({ warning: (m: string) => warnings.push(m) }),
            challengeTag: () => '[tag]',
        });
        logChosenSkipOnce(spy, buildChallenge({ id: 's69' }), 'autoFill', 'none-usable');
        expect(warnings).toEqual([]); // still remembered
        logChosenSkipOnce(spy, buildChallenge({ id: 's0' }), 'autoFill', 'none-usable');
        expect(warnings).toHaveLength(1); // the early ones were forgotten and are explained again
    });

    test('scores for a found photo are merged into scores that already exist, or stand alone', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), photo('car', ['Car'])],
            settings: { chosen: ['car'] },
        });
        deps.getSemanticScores
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(new Map([['car', { score: 0.9, support: 2 }]]) as never);
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['car']]);
    });

    test('a found photo is scored with the semantic scorer and never searched when enough are usable', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), car],
            settings: { chosen: ['car'] },
        });
        // With an existing score map the found photo's scores are merged into it.
        deps.getSemanticScores.mockResolvedValue(new Map([['theme-a', { score: 0.9, support: 1 }]]) as never);
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(deps.getSemanticScores).toHaveBeenCalledTimes(2);
        expect(submittedIds(deps)).toEqual([['car']]);

        // Enough usable chosen photos for the slots wanted: no lookup for the rest.
        const enough = makeDeps({ settings: { chosen: ['theme-a', 'car'] } });
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, enough);
        expect(enough.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });

    test('resolveMissingChosen only returns the matching chosen records', async () => {
        const { logger } = makeLog();
        const challenge = makeChallenge();
        const walked = [photo('theme-a'), car, photo('other', ['Car'])];
        const found = await resolveMissingChosen({
            challenge,
            token: 'tok',
            ids: ['car', 'gone'],
            eligible: [photo('theme-a')],
            wantCount: 2,
            allowWalk: true,
            deps: { getEligiblePhotosWalk: jest.fn(async () => ({ items: walked, truncated: false })), logger },
            label: 'join',
        });
        expect(found.map((p) => p.id)).toEqual(['car']);
        expect(recallChosenPhotos(challenge, ['car', 'gone']).map((p) => p.id)).toEqual(['car']);
    });
});

describe('Submit Only Chosen Photos', () => {
    test('a challenge with no usable chosen photo is skipped, explained once, and explained again after a change', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, settings: { chosen: ['car'], only: true } });
        const challenge = makeChallenge();
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('skipped');
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('skipped');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
        const skips = lines.warning.filter((m) => m.includes('skipped [Challenge c1]'));
        expect(skips).toHaveLength(1);
        expect(skips[0]).toContain('none of your chosen photos can be submitted there');
        expect(skips[0]).toContain('turn Emergency Submit off for this challenge to keep the slot empty');

        // A usable chosen photo appears: submitted, and the skip state is cleared...
        deps.settings.getEffectiveSetting.mockImplementation(
            (key: string) =>
                ({ autoFill: true, chosenPhotos: ['theme-a'], chosenPhotosOnly: true })[key] ??
                (key === 'autoFillSchedule' ? [{ count: 4, seconds: 600 }] : null),
        );
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        // ...so skipping again later is explained again.
        deps.settings.getEffectiveSetting.mockImplementation(
            (key: string) =>
                ({ autoFill: true, chosenPhotos: ['car'], chosenPhotosOnly: true })[key] ??
                (key === 'autoFillSchedule' ? [{ count: 4, seconds: 600 }] : null),
        );
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(lines.warning.filter((m) => m.includes('skipped [Challenge c1]'))).toHaveLength(2);
    });

    test('with every chosen photo already entered it skips without fetching anything', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({ logger, settings: { chosen: ['existing'], only: true } });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('skipped');
        expect(deps.getEligiblePhotos).not.toHaveBeenCalled();
        expect(lines.warning.some((m) => m.includes('every chosen photo is already entered there'))).toBe(true);
    });

    test('with Only off and every chosen photo entered the chosen tier is skipped before any lookup', async () => {
        const deps = makeDeps({ settings: { chosen: ['existing'], only: false } });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
        expect(submittedIds(deps)).toEqual([['theme-a']]);
    });

    test('an empty list behaves as off', async () => {
        const deps = makeDeps({ settings: { chosen: [], only: true } });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
    });

    test('the hard filters decide: a chosen photo failing the must-tags skips while other photos pass', async () => {
        const deps = makeDeps({
            library: [photo('theme-a', ['Pink']), photo('car', ['Car'])],
            settings: { chosen: ['car'], only: true, must: ['Pink'], fillWithoutTagMatch: false },
        });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('skipped');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('manual fill never applies it', async () => {
        const deps = makeDeps({ settings: { chosen: ['car'], only: true } });
        const result = await fillChallengeNow(makeChallenge(), 'tok', 'one', deps);
        expect(result).toEqual({ success: true, submitted: 1, skipped: 2 });
        expect(submittedIds(deps)).toEqual([['theme-a']]);
    });

    test('fill-new reports it as its own reason', async () => {
        const deps = makeDeps({ settings: { chosen: ['car'], only: true } });
        await expect(submitNewEntryForAction(makeChallenge(), 'tok', deps)).resolves.toEqual({
            ok: false,
            imageId: null,
            reason: 'no-chosen',
        });
    });
});

describe('emergency fill', () => {
    const emergencyChallenge = (over = {}) => makeChallenge({ entries: [], closeIn: 200, ...over });

    test('ignores Only and ranks the chosen photos first', async () => {
        const deps = makeDeps({
            library: [photo('theme-a'), photo('theme-b'), photo('car', ['Car'])],
            settings: { autoFill: false, chosen: ['car'], only: true },
        });
        expect(await maybeEmergencyFillChallenge(emergencyChallenge(), 'tok', NOW, deps)).toBe('submitted');
        // Never walks the library near the deadline, and leaves the unfound chosen photo out.
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
        expect(submittedIds(deps)[0]).toHaveLength(2);
        expect(submittedIds(deps)[0]).toEqual(expect.arrayContaining(['theme-a', 'theme-b']));
    });

    test('a batch cut to the free slots keeps the chosen photos at its head', async () => {
        const library = [photo('theme-a'), photo('theme-b'), photo('theme-c'), photo('theme-d')];
        const deps = makeDeps({
            library,
            settings: { autoFill: false, chosen: ['theme-d'] },
            extra: {
                getActiveChallenges: jest.fn().mockResolvedValue({
                    challenges: [
                        {
                            id: 'c1',
                            member: {
                                boost: { state: 'LOCKED', timeout: 0 },
                                ranking: {
                                    entries: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
                                    exposure: { exposure_factor: 100 },
                                },
                            },
                        },
                    ],
                }),
            },
        });
        expect(await maybeEmergencyFillChallenge(emergencyChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-d']]);
    });

    describe('the stand-down probe sees the chosen photos the way the staggered path would', () => {
        test('Only with nothing usable: staggered would skip, so emergency steps in', async () => {
            const deps = makeDeps({ settings: { autoFill: true, chosen: ['car'], only: true } });
            expect(await maybeEmergencyFillChallenge(emergencyChallenge(), 'tok', NOW, deps)).toBe('submitted');
        });

        test('Only with a usable chosen photo: staggered fills it, so emergency stands down', async () => {
            const deps = makeDeps({ settings: { autoFill: true, chosen: ['theme-a'], only: true } });
            expect(await maybeEmergencyFillChallenge(emergencyChallenge(), 'tok', NOW, deps)).toBe('skipped');
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test('Only with every chosen photo entered: staggered would skip, so emergency steps in', async () => {
            const deps = makeDeps({ settings: { autoFill: true, chosen: ['existing'], only: true } });
            expect(
                await maybeEmergencyFillChallenge(
                    emergencyChallenge({ entries: [{ id: 'existing' }] }),
                    'tok',
                    NOW,
                    deps,
                ),
            ).toBe('submitted');
        });

        test('a chosen photo only a walk can reach counts when the memo says it was found', async () => {
            const { logger } = makeLog();
            const challenge = emergencyChallenge();
            const car = photo('car', ['Car']);
            // The staggered path walked earlier and found it; emergency may not walk, only recall.
            await resolveMissingChosen({
                challenge,
                token: 'tok',
                ids: ['car'],
                eligible: [],
                wantCount: 1,
                allowWalk: true,
                deps: { getEligiblePhotosWalk: jest.fn(async () => ({ items: [car], truncated: false })), logger },
                label: 'autoFill',
            });
            const standsDown = makeDeps({ settings: { autoFill: true, chosen: ['car'], only: true } });
            expect(await maybeEmergencyFillChallenge(challenge, 'tok', NOW, standsDown)).toBe('skipped');

            // Not found, by contrast: emergency fill takes over.
            __resetChosenPhotos();
            await resolveMissingChosen({
                challenge,
                token: 'tok',
                ids: ['car'],
                eligible: [],
                wantCount: 1,
                allowWalk: true,
                deps: { getEligiblePhotosWalk: jest.fn(async () => ({ items: [], truncated: false })), logger },
                label: 'autoFill',
            });
            const steps = makeDeps({ settings: { autoFill: true, chosen: ['car'], only: true } });
            expect(await maybeEmergencyFillChallenge(challenge, 'tok', NOW, steps)).toBe('submitted');
        });
    });

    test('the deadline view and the runner agree on whether auto-fill owns the challenge', () => {
        const challenge = emergencyChallenge();
        const verdict = (spec: SettingsSpec) => evaluateEmergencyFill(challenge, 'c1', makeSettings(spec)).standDown;
        expect(verdict({ autoFill: true })).toBe(true);
        expect(verdict({ autoFill: true, chosen: ['car'], only: false })).toBe(true);
        expect(verdict({ autoFill: true, chosen: [], only: true })).toBe(true);
        expect(verdict({ autoFill: true, chosen: ['car'], only: true })).toBe(false);
        expect(verdict({ autoFill: true, chosen: 'not-a-list', only: true })).toBe(true);
        // Auto-fill off, or a must-include filter: already "may fill" without reading them.
        const read = (spec: SettingsSpec) => {
            const settings = makeSettings(spec);
            evaluateEmergencyFill(challenge, 'c1', settings);
            return settings.getEffectiveSetting.mock.calls.map((call) => call[0]);
        };
        expect(read({ autoFill: false, chosen: ['car'], only: true })).not.toContain('chosenPhotos');
        expect(read({ autoFill: true, must: ['Pink'], chosen: ['car'], only: true })).not.toContain('chosenPhotos');
        expect(read({ autoFill: true, chosen: ['car'], only: true })).toContain('chosenPhotosOnly');
    });
});

describe('the list belongs to the account that saved it', () => {
    test('another account ignores it, with one line however many fills', async () => {
        const { logger, lines } = makeLog();
        const deps = makeDeps({
            logger,
            member: 'member-2',
            settings: { chosen: ['theme-b'], savedBy: 'member-1', only: true },
        });
        // Ignored, so Only has nothing to enforce and the automatic pick is made.
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)[0]).toEqual(['theme-a']);
        expect(lines.warning.filter((m) => m.includes('saved while another account was signed in'))).toHaveLength(1);
    });

    test.each([
        ['the same account', 'member-1', 'member-1'],
        ['no recorded account', 'member-1', ''],
        ['an account that cannot be told', null, 'member-9'],
    ])('applies for %s', async (_name, member, savedBy) => {
        const deps = makeDeps({ member, settings: { chosen: ['theme-b'], savedBy } });
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-b']]);
    });

    test('an identity lookup that finds nobody leaves the list in force', async () => {
        const deps = makeDeps({ settings: { chosen: ['theme-b'], savedBy: 'member-1' } });
        deps.getCurrentMemberProfile = jest.fn(async () => null) as never;
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-b']]);
    });

    test('settings that cannot be read leave no list', async () => {
        const deps = makeDeps();
        deps.settings = undefined as never;
        const result = await fillChallengeNow(makeChallenge(), 'tok', 'one', deps);
        expect(result.success).toBe(true);
    });
});
