/**
 * The user's chosen photos through every fill path: they rank first, a chosen
 * photo the themed fetch missed is looked up once (and remembered), Submit Only
 * Chosen Photos skips a challenge it cannot serve — except for manual fills and
 * emergency fill — and the emergency stand-down check agrees with the runner.
 */

import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
import type * as verifyModule from '../../src/ts/services/autoFill/pipeline/verify';
import type * as photoPickerModule from '../../src/ts/services/photoPicker';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { FillDeps, FillLogger, FillSettings, RankDeps } from '../../src/ts/types/autoFill';
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
    rankCandidatesForChallenge,
    __resetMemberIdCache,
} = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { forgetChosenPhotosMemory, resolveMissingChosen, logChosenSkipOnce } =
    require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { verifyFillPick } = require('../../src/ts/services/autoFill/pipeline/verify') as typeof verifyModule;
const { buildChosenCandidates } = require('../../src/ts/services/photoPicker') as typeof photoPickerModule;
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

// What the memo holds for these ids on a challenge: the lookup with no walk allowed.
const recalled = async (challenge: ReturnType<typeof makeChallenge>, ids: string[]) =>
    (
        await resolveMissingChosen({
            challenge,
            token: 'tok',
            ids,
            eligible: [],
            wantCount: ids.length,
            allowWalk: false,
            deps: { logger: makeLog().logger },
            label: 'autoFill',
        })
    ).map((p) => p.id);

beforeEach(() => {
    forgetChosenPhotosMemory();
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

    test('the visual evidence of both blocks is combined, and each block reorders only itself', async () => {
        const challenge = makeChallenge();
        const photos = ['c1', 'c2', 'r1', 'r2', 'r3'].map((id, n) => photo(id, ['Pink'], { upload_date: 9000 - n }));
        const { scored, chosenIds } = buildChosenCandidates(challenge, photos, {
            chosen: { ids: ['c1', 'c2'], only: false },
        });
        // Each block's model run sees only its own photos and confirms its first one.
        const seen: string[][] = [];
        const rankVisually = jest.fn(
            async (
                _c: unknown,
                ids: string[],
                _e: unknown,
                want: number,
                options?: { onVisualEvidence?: (accepted: Set<string>) => void },
            ) => {
                seen.push([...ids].sort());
                options?.onVisualEvidence?.(new Set([ids[0]]));
                return ids.slice(0, want);
            },
        );
        const verified = await verifyFillPick(
            challenge,
            scored,
            photos,
            ['c1', 'r1'],
            null,
            invalid({ logger: makeLog().logger, rankVisually }),
            chosenIds,
        );
        expect(verified.picked).toEqual(['c1', 'r1']);
        expect([...(verified.visualEvidence as Set<string>)].sort()).toEqual(['c1', 'r1']);
        // Two runs, one per block, and a chosen photo never competes with a top-up photo.
        expect(seen).toHaveLength(2);
        expect(seen[0].every((id) => id.startsWith('c'))).toBe(true);
        expect(seen[1].every((id) => id.startsWith('r'))).toBe(true);
    });

    test('an empty chosen set behaves exactly like no list, evidence and uncertainty included', async () => {
        const run = async (chosen: string[]) => {
            forgetChosenPhotosMemory();
            const ledger = createMemoryEntryAgeLedger();
            const challenge = makeChallenge({ title: 'Dogs' });
            const deps = makeDeps({
                library: [photo('car', ['Car'])],
                settings: { chosen },
                extra: { entryAges: ledger },
            });
            // The model confirms the subject, so the photo is not doubtful.
            deps.rankVisually.mockImplementation(async (_c, ids, _e, want, options) => {
                options?.onVisualEvidence?.(new Set(ids.slice(0, want)));
                return ids.slice(0, want);
            });
            expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
            return {
                submitted: submittedIds(deps),
                modelRuns: deps.rankVisually.mock.calls.length,
                uncertain: ledger.isUncertain(challenge.id, 'car'),
            };
        };
        const none = await run([]);
        // A list none of whose photos can be entered has an empty chosen block: the same outcome.
        expect(await run(['ghost'])).toEqual(none);
        expect(none).toEqual({ submitted: [['car']], modelRuns: 1, uncertain: false });
    });

    test('verifyFillPick treats an empty chosen set as no list: the one block is re-ranked even when it fills its slots', async () => {
        const challenge = makeChallenge();
        const photos = [photo('a'), photo('b')];
        const { scored } = buildChosenCandidates(challenge, photos, {});
        const rankVisually = jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number) =>
            ids.slice(0, want),
        );
        const deps = invalid<RankDeps>({ logger: makeLog().logger, rankVisually });
        await verifyFillPick(challenge, scored, photos, ['a', 'b'], null, deps, new Set());
        await verifyFillPick(challenge, scored, photos, ['a', 'b'], null, deps, null);
        expect(rankVisually).toHaveBeenCalledTimes(2);
    });

    test('with Only on and Submit Even Without a Tag Match on, the tag check relaxes on the chosen photos alone', async () => {
        const deps = makeDeps({
            library: [photo('theme-a', ['Pink']), photo('car', ['Car'])],
            settings: { chosen: ['car'], only: true, must: ['Pink'], fillWithoutTagMatch: true },
        });
        // theme-a fits the tags but is not chosen; car does not fit them, yet it is the only candidate
        // and so the relaxation applies to it alone: it is entered, theme-a never is.
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['car']]);
    });

    test('a chosen photo is never marked uncertain, however off-theme it is', async () => {
        for (const [chosen, uncertain] of [
            [['car'], false],
            [[], true],
        ] as const) {
            forgetChosenPhotosMemory();
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

    test('a rejected submit refuses only the remembered photo it used — for that challenge only', async () => {
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
        // Newest first, so the scorer's last tie-break puts the car ahead of the dog.
        const full = [photo('theme-a'), photo('car', ['Car'], { upload_date: 9500 }), photo('dog', ['Dog'])];
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: full,
            settings: { chosen: ['car', 'dog'] },
        });
        deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: { success: false } }));
        const challenge = makeChallenge();
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('error');
        // The photo that was submitted is refused; the other one found by the same walk is kept.
        expect(await recalled(challenge, ['car', 'dog'])).toEqual(['dog']);
        expect(await recalled(other, ['car'])).toEqual(['car']);
        // A submit that got no answer teaches nothing: the photo it used stays found.
        deps.submitToChallenge.mockRejectedValue(new Error('boom'));
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('error');
        expect(await recalled(challenge, ['car', 'dog'])).toEqual(['dog']);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
    });

    describe('after a failed submit', () => {
        const run = async (fail: (deps: ReturnType<typeof makeDeps>) => void, passes: number, clockAt?: number[]) => {
            forgetChosenPhotosMemory();
            const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
            const deps = makeDeps({
                library: [photo('theme-a')],
                walkItems: [photo('theme-a'), photo('car', ['Car'])],
                settings: { chosen: ['car'] },
            });
            fail(deps);
            const challenge = makeChallenge();
            for (let pass = 0; pass < passes; pass++) {
                if (clockAt) clock.mockReturnValue(5_000_000 + clockAt[pass] * 60_000);
                expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('error');
            }
            return deps;
        };

        test.each([
            [
                'threw',
                (deps: ReturnType<typeof makeDeps>) => deps.submitToChallenge.mockRejectedValue(new Error('timeout')),
            ],
            [
                'got no body',
                (deps: ReturnType<typeof makeDeps>) =>
                    deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: null })),
            ],
        ])('a submit that %s teaches nothing: the photo stays found and no pass walks again', async (_name, fail) => {
            const deps = await run(fail, 5);
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
            // Every pass submitted the remembered photo.
            expect(submittedIds(deps)).toEqual(Array(5).fill(['car']));
        });

        test.each([
            ['an error body with no success field', { error: 'photo not allowed' }],
            ['an empty body', {}],
        ])("%s is the server's answer too: the photo is held back", async (_name, raw) => {
            const deps = await run(
                (d) => d.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw })),
                2,
                [0, 1],
            );
            // The second pass submits the top-up and does not look the refused photo up again.
            expect(submittedIds(deps)).toEqual([['car'], ['theme-a']]);
        });

        test('a server refusal holds the remembered photo back for ten minutes only', async () => {
            const refuse = (deps: ReturnType<typeof makeDeps>) =>
                deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: { success: false } }));
            // Pass 1 walks and submits the car (refused), passes 2 and 3 submit the top-up and do
            // not look the car up again; once ten minutes have passed it is looked up once more.
            const deps = await run(refuse, 4, [0, 1, 9, 11]);
            expect(submittedIds(deps)).toEqual([['car'], ['theme-a'], ['theme-a'], ['car']]);
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
        });
    });

    test('a known id put back as unresolved keeps the back-off count; only a never-seen id starts it over', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
        const deps = makeDeps({
            library: [photo('theme-a')],
            // Reaches "bee" but not "ant": cut short, so "ant" waits.
            walkItems: [photo('theme-a'), photo('bee', ['Bee'])],
            walkTruncated: true,
            settings: { chosen: ['ant', 'bee'], only: true },
        });
        const challenge = makeChallenge();
        const min = 60_000;
        const at = async (minutes: number) => {
            clock.mockReturnValue(5_000_000 + minutes * min);
            await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
            return deps.getEligiblePhotosWalk.mock.calls.length;
        };
        expect(await at(0)).toBe(1); // wait: 5 minutes
        // The outcomes (and "bee") expire after the TTL; "bee" is unresolved again, and known.
        expect(await at(31)).toBe(2); // wait: 10 minutes, not 5 — the count was kept
        expect(await at(36)).toBe(2);
        expect(await at(41)).toBe(3);
        // A genuinely new id is looked up at once, and the count starts over (wait: 5 minutes).
        deps.settings.getEffectiveSetting.mockImplementation(
            (key: string) =>
                ({ autoFill: true, chosenPhotos: ['ant', 'bee', 'cat'], chosenPhotosOnly: true })[key] ??
                (key === 'autoFillSchedule' ? [{ count: 4, seconds: 600 }] : null),
        );
        expect(await at(42)).toBe(4);
        expect(await at(46)).toBe(4);
        expect(await at(47)).toBe(5);
    });

    test('two rejections of the same photo cause only one walk', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), photo('car', ['Car'])],
            settings: { chosen: ['car'] },
        });
        deps.submitToChallenge.mockResolvedValue(invalid({ ok: false, raw: { success: false } }));
        const challenge = makeChallenge();
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('error');
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('error');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        // The first attempt submitted the chosen photo, the second a top-up: the refused one is not retried.
        expect(submittedIds(deps)).toEqual([['car'], ['theme-a']]);
    });

    test('a submitted chosen photo does not hide the next found one from the emergency probe', async () => {
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a'), photo('car', ['Car']), photo('dog', ['Dog'])],
            settings: { chosen: ['car', 'dog'] },
        });
        const challenge = makeChallenge({ entries: [], closeIn: 200 });
        // The staggered path walks once and submits one of the two chosen photos.
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        const [first] = submittedIds(deps)[0];
        const remaining = first === 'car' ? 'dog' : 'car';
        // Emergency fill may not walk: it still sees the photo the first walk found.
        deps.settings.getEffectiveSetting.mockImplementation(
            (key: string) =>
                ({ autoFill: false, chosenPhotos: ['car', 'dog'], chosenPhotosOnly: false, emergencyFill: 300 })[key] ??
                null,
        );
        expect(await maybeEmergencyFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        expect(submittedIds(deps)[1][0]).toBe(remaining);
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

    test('the pause after a cut-short walk doubles each time, up to an hour', async () => {
        const start = 5_000_000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a')],
            walkTruncated: true,
            settings: { chosen: ['car'], only: true },
        });
        const challenge = makeChallenge();
        const min = 60_000;
        // Each wait is measured from the walk before it: 5, 10, 20, 40, then 60 (capped), 60.
        let walks = 0;
        let at = start;
        for (const wait of [5, 10, 20, 40, 60, 60]) {
            clock.mockReturnValue(at);
            await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(++walks);
            // One minute short of the wait: no walk.
            clock.mockReturnValue(at + wait * min - min);
            await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
            expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(walks);
            at += wait * min;
        }
    });

    test('a newly chosen photo is not made to wait out the pause set for older ones', async () => {
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
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);

        // The user adds a photo the (still cut short) walk can reach: it is looked for at once.
        const dog = photo('dog', ['Dog']);
        deps.settings.getEffectiveSetting.mockImplementation(
            (key: string) =>
                ({ autoFill: true, chosenPhotos: ['car', 'dog'], chosenPhotosOnly: true, fillWithoutTagMatch: true })[
                    key
                ] ?? (key === 'autoFillSchedule' ? [{ count: 4, seconds: 600 }] : null),
        );
        deps.getEligiblePhotosWalk.mockResolvedValue({ items: [photo('theme-a'), dog], truncated: true });
        clock.mockReturnValue(5_000_001);
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
        expect(submittedIds(deps)).toEqual([['dog']]);
        // The ids already covered by the pause still wait: the unreached "car" is not walked for again.
        reflectNewEntry(challenge, 'dog');
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('a walk that throws waits like one that was cut short', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
        const deps = makeDeps({ library: [photo('theme-a')], settings: { chosen: ['car'], only: true } });
        deps.getEligiblePhotosWalk.mockRejectedValue(new Error('library down'));
        const challenge = makeChallenge();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(5_000_000 + 4 * 60_000);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(5_000_000 + 5 * 60_000);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
        // ...and the second failure doubles the pause (10 minutes).
        clock.mockReturnValue(5_000_000 + 14 * 60_000);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('the pause starts over once a walk reaches every unresolved photo', async () => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
        const deps = makeDeps({
            library: [photo('theme-a')],
            walkItems: [photo('theme-a')],
            walkTruncated: true,
            settings: { chosen: ['car'], only: true },
        });
        const challenge = makeChallenge();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        clock.mockReturnValue(5_000_000 + 5 * 60_000);
        deps.getEligiblePhotosWalk.mockResolvedValue({ items: [photo('theme-a')], truncated: false });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
        // Complete: the id is "not found" and stays so, however much later within the memo.
        clock.mockReturnValue(5_000_000 + 6 * 60_000);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('a changed entry count drops only the negative outcomes, a found photo stays', async () => {
        const walk = jest.fn(async () => ({ items: [car], truncated: false }));
        const { logger } = makeLog();
        const challenge = makeChallenge();
        const lookup = async () =>
            resolveMissingChosen({
                challenge,
                token: 'tok',
                ids: ['car', 'gone'],
                eligible: [],
                wantCount: 2,
                allowWalk: true,
                deps: { getEligiblePhotosWalk: walk, logger },
                label: 'autoFill',
            });
        expect((await lookup()).map((p) => p.id)).toEqual(['car']);
        reflectNewEntry(challenge, 'someone');
        // "gone" is asked about again (one more walk); "car" is kept without being asked.
        expect((await lookup()).map((p) => p.id)).toEqual(['car']);
        expect(walk).toHaveBeenCalledTimes(2);
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
            .mockResolvedValueOnce(invalid(new Map([['car', { score: 0.9, support: 2 }]])));
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
        deps.getSemanticScores.mockResolvedValue(invalid(new Map([['theme-a', { score: 0.9, support: 1 }]])));
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
        expect(await recalled(challenge, ['car', 'gone'])).toEqual(['car']);
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

    test('a full batch submits the chosen photos first, then the top-ups, each block in scorer order', async () => {
        // Newest upload wins a tie, so the order inside each block is fixed.
        const library = [
            photo('theme-a', ['Pink'], { upload_date: 9200 }),
            photo('theme-b', ['Pink'], { upload_date: 9100 }),
            photo('theme-c', ['Pink'], { upload_date: 9300 }),
            photo('theme-d', ['Pink'], { upload_date: 9400 }),
        ];
        const deps = makeDeps({ library, settings: { autoFill: false, chosen: ['theme-c', 'theme-d'] } });
        expect(await maybeEmergencyFillChallenge(emergencyChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-d', 'theme-c', 'theme-a', 'theme-b']]);
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
            forgetChosenPhotosMemory();
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
        expect(lines.warning.filter((m) => m.includes('saved while another account was logged in'))).toHaveLength(1);
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
        deps.getCurrentMemberProfile = invalid(jest.fn(async () => null));
        expect(await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps)).toBe('submitted');
        expect(submittedIds(deps)).toEqual([['theme-b']]);
    });

    test('settings that cannot be read leave no list', async () => {
        const deps = makeDeps();
        deps.settings = invalid(undefined);
        const result = await fillChallengeNow(makeChallenge(), 'tok', 'one', deps);
        expect(result.success).toBe(true);
    });
});

describe('forgetChosenPhotosMemory (a logout)', () => {
    test('the walk memo is dropped: the next account looks the photo up again', async () => {
        const deps = makeDeps({ library: [photo('theme-a')], settings: { chosen: ['car'], only: true } });
        const challenge = makeChallenge();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(1);

        forgetChosenPhotosMemory();
        await maybeAutoFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.getEligiblePhotosWalk).toHaveBeenCalledTimes(2);
    });

    test('the explained skip and the owner-mismatch warning are given again to the next account', async () => {
        const skipLog = makeLog();
        const deps = makeDeps({
            logger: skipLog.logger,
            library: [photo('theme-a')],
            settings: { chosen: ['car'], only: true },
        });
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(skipLog.lines.warning.filter((m) => m.includes('skipped'))).toHaveLength(1);
        forgetChosenPhotosMemory();
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, deps);
        expect(skipLog.lines.warning.filter((m) => m.includes('skipped'))).toHaveLength(2);

        const mismatchLog = makeLog();
        const other = makeDeps({
            logger: mismatchLog.logger,
            member: 'member-2',
            settings: { chosen: ['theme-b'], savedBy: 'member-1', only: true },
        });
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, other);
        forgetChosenPhotosMemory();
        await maybeAutoFillChallenge(makeChallenge(), 'tok', NOW, other);
        expect(
            mismatchLog.lines.warning.filter((m) => m.includes('saved while another account was logged in')),
        ).toHaveLength(2);
    });
});

describe('swap ranking ignores the chosen photos settings', () => {
    const rank = async (settings: SettingsSpec) => {
        forgetChosenPhotosMemory();
        const deps = makeDeps({
            library: [
                photo('theme-a', ['Pink'], { upload_date: 9300 }),
                photo('theme-b', ['Pink'], { upload_date: 9200 }),
            ],
            walkItems: [photo('theme-a'), photo('theme-b'), photo('car', ['Car'])],
            settings,
        });
        const result = await rankCandidatesForChallenge(makeChallenge(), 'tok', deps, {
            usage: 'swap',
            wantCount: 3,
        });
        return { result, deps };
    };

    test('the output is identical with the settings set, and no library walk looks for a chosen photo', async () => {
        const plain = await rank({});
        const chosen = await rank({ chosen: ['car'], only: true });
        expect(chosen.result).toEqual(plain.result);
        expect(chosen.result).toEqual({
            status: 'ranked',
            picked: [expect.objectContaining({ id: 'theme-a' }), expect.objectContaining({ id: 'theme-b' })],
        });
        expect(chosen.deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
        // The settings are never even read.
        const asked = chosen.deps.settings.getEffectiveSetting.mock.calls.map((call) => call[0]);
        expect(asked).not.toContain('chosenPhotos');
        expect(asked).not.toContain('chosenPhotosOnly');
    });
});
