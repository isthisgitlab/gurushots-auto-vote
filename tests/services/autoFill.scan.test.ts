/**
 * The read-only photo scan (scanFillCandidates): the same candidate listing and scoring a submission runs, reporting
 * how many photos are eligible, whether the scan finished, and why there is nothing to submit. A scan that stopped
 * early never reports zero as a fact, and it leaves nothing behind that a later real fill would notice.
 */

import type * as autoFillModule from '../../src/ts/core/services/autoFill';
import type * as chosenPhotosModule from '../../src/ts/core/services/autoFill/chosenPhotos';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { FillDeps, FillLogger, FillSettings } from '../../src/ts/core/types/autoFill';
import type { LibraryPhoto } from '../../src/ts/core/types/gurushots';
import type { PickerPhoto } from '../../src/ts/core/types/photoPicker';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/core/services/semantic/lexicon', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/semantic/lexicon')>(
        '../../src/ts/core/services/semantic/lexicon',
    ),
}));
jest.mock('../../src/ts/core/settings/storage', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/settings/storage')>('../../src/ts/core/settings/storage'),
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/photo-scan.json',
        initializeAsync: async () => {},
    }),
}));
const { scanFillCandidates, submitNewEntryForAction, __resetMemberIdCache } =
    require('../../src/ts/core/services/autoFill') as typeof autoFillModule;
const { forgetChosenPhotosMemory } =
    require('../../src/ts/core/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const NOW = 1_000_000;

const photo = (id: string, labels: string[] = ['Pink'], extra: Partial<PickerPhoto> = {}): PickerPhoto => ({
    id,
    labels,
    upload_date: 9000,
    permission: { allowed: true, message: null },
    ...extra,
});

const makeChallenge = ({ entries = [{ id: 'existing' }], swaps }: { entries?: unknown[]; swaps?: unknown[] } = {}) =>
    buildChallenge({
        id: 'c1',
        title: 'Pink In Nature',
        url: 'pink-in-nature23',
        max_photo_submits: 4,
        close_time: NOW + 600,
        member: { ranking: { entries, swaps } },
    });

type Line = { category: string; level: string; message: string };
let lines: Line[] = [];
const logger = invalid<FillLogger>({
    withCategory: (category: string) =>
        Object.fromEntries(
            ['info', 'warning', 'success', 'error', 'debug'].map((level) => [
                level,
                (message: string) => lines.push({ category, level, message }),
            ]),
        ),
    challengeTag: (c: Parameters<FillLogger['challengeTag']>[0]) =>
        `[Challenge ${c && typeof c === 'object' ? c.id : c}]`,
});

const makeSettings = ({
    chosen = [],
    only = false,
}: { chosen?: string[]; only?: boolean } = {}): jest.MockedObject<FillSettings> =>
    invalid({
        getEffectiveSetting: jest.fn((key: string) => {
            switch (key) {
                case 'submitWithoutTagMatch':
                    return true;
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
        getEffectiveTagSetting: jest.fn(() => []),
        getEffectiveIgnoreTitleWords: jest.fn(() => null),
    });

type Options = {
    search?: string;
    order?: string;
    paginate?: boolean;
    readState?: { firstPageFailed: boolean; truncated?: boolean };
};
type LibraryRead = (opts: Options) => LibraryPhoto[] | Promise<LibraryPhoto[]>;

/** A library whose themed search finds the pink photos and whose unfiltered read returns all of it. */
const reading =
    (library: PickerPhoto[], onRead: (opts: Options) => void = () => undefined): LibraryRead =>
    (opts) => {
        onRead(opts);
        return invalid<LibraryPhoto[]>(
            opts.search ? library.filter((p) => (p.labels ?? []).includes(opts.search ?? '')) : library,
        );
    };

const makeDeps = (read: LibraryRead, over: Record<string, unknown> = {}) => {
    const deps = {
        settings: makeSettings(),
        logger,
        getEligiblePhotos: jest.fn(async (_id: string | number, _token: string, opts: Options = {}) => read(opts)),
        getEligiblePhotosWalk: jest.fn(async () => ({
            items: [],
            truncated: false,
            nextStart: 0,
            stop: 'end' as const,
        })),
        getSemanticScores: jest.fn(async () => null),
        submitToChallenge: jest.fn(async () => invalid({ ok: true, raw: { success: true } })),
        getActiveChallenges: jest.fn(),
        rankVisually: jest.fn(async (_c: unknown, ids: string[], _e: unknown, want: number) => ids.slice(0, want)),
        ...over,
    };
    return deps as typeof deps & FillDeps;
};

const scan = (deps: FillDeps, challenge = makeChallenge()) =>
    scanFillCandidates({
        challenge,
        token: 'tok',
        deps,
        mustIncludeTags: null,
        shouldIncludeTags: null,
        submitWithoutTagMatch: undefined,
    });

beforeEach(() => {
    lines = [];
    forgetChosenPhotosMemory();
    __resetMemberIdCache();
    jest.clearAllMocks();
});

describe('a finished scan', () => {
    test('counts the photos the ranking pool holds, and submits nothing', async () => {
        const deps = makeDeps(reading([photo('a'), photo('b'), photo('c', ['Car'])]));
        await expect(scan(deps)).resolves.toEqual({ eligible: 3, complete: true });
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
        // the vision check only reorders a pick: it cannot change the count, so the scan does not pay for it
        expect(deps.rankVisually).not.toHaveBeenCalled();
        // no live re-check: nothing is merged into the challenge
        expect(deps.getActiveChallenges).not.toHaveBeenCalled();
    });

    test("shares the submission's rule: photos the server does not allow, and photos the swap history took out, are not counted", async () => {
        const library = [
            photo('ok'),
            photo('blocked', ['Pink'], { permission: { allowed: false, message: 'no' } }),
            photo('swapped'),
        ];
        const challenge = makeChallenge({ swaps: [{ id: 'swapped' }] });
        const deps = makeDeps(reading(library));
        const scanned = await scan(deps, challenge);
        expect(scanned.eligible).toBe(1);
        // and the submission over the same challenge picks that one photo
        const submitDeps = makeDeps(reading(library));
        await submitNewEntryForAction(challenge, 'tok', submitDeps);
        expect(submitDeps.submitToChallenge.mock.calls.map((call) => (call as unknown[])[1])).toEqual([['ok']]);
    });

    test('a library with nothing eligible, fully read, proves there are none', async () => {
        await expect(scan(makeDeps(reading([])))).resolves.toEqual({
            eligible: 0,
            complete: true,
            firstReason: 'no-eligible-photo',
        });
        await expect(
            scan(makeDeps(reading([photo('x', ['Pink'], { permission: { allowed: false, message: null } })]))),
        ).resolves.toEqual({
            eligible: 0,
            complete: true,
            firstReason: 'no-eligible-photo',
        });
    });

    test('Submit Only Chosen Photos with every chosen photo already entered: nothing to choose, no read made', async () => {
        const deps = makeDeps(reading([photo('a')]), { settings: makeSettings({ chosen: ['existing'], only: true }) });
        await expect(scan(deps)).resolves.toEqual({ eligible: 0, complete: true, firstReason: 'no-chosen-photo' });
        expect(deps.getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('Submit Only Chosen Photos with a chosen photo the themed search missed: not looked up, so the pool is a lower bound', async () => {
        const settings = makeSettings({ chosen: ['missing'], only: true });
        const deps = makeDeps(reading([photo('a')]), { settings });
        await expect(scan(deps)).resolves.toEqual({ eligible: 0, complete: false, firstReason: 'no-chosen-photo' });
        // the lookup keeps a memo and writes a line that a later fill owns: the scan does not make it
        expect(deps.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });

    test('Submit Only Chosen Photos with the chosen photo offered: it is the pool', async () => {
        const settings = makeSettings({ chosen: ['a'], only: true });
        await expect(scan(makeDeps(reading([photo('a'), photo('b')]), { settings }))).resolves.toEqual({
            eligible: 1,
            complete: true,
        });
    });
});

describe('a scan that cannot prove its answer', () => {
    test('a fetch that fails is incomplete with zero found, never "none"', async () => {
        const deps = makeDeps(() => {
            throw new Error('library down');
        });
        await expect(scan(deps)).resolves.toEqual({ eligible: 0, complete: false, firstReason: 'photo-read-failed' });
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a read cut short (the page cap, the time budget, a failed page) gives a lower bound', async () => {
        const cut = makeDeps(
            reading([photo('a'), photo('b')], (opts) => {
                if (opts.readState && opts.readState.truncated !== undefined) opts.readState.truncated = true;
            }),
        );
        await expect(scan(cut)).resolves.toEqual({
            eligible: 2,
            complete: false,
            firstReason: 'photo-read-incomplete',
        });
    });

    test('a cut-short read that found nothing cannot prove there is nothing', async () => {
        const cut = makeDeps(
            reading([], (opts) => {
                if (opts.readState && opts.readState.truncated !== undefined) opts.readState.truncated = true;
            }),
        );
        await expect(scan(cut)).resolves.toEqual({ eligible: 0, complete: false, firstReason: 'no-eligible-photo' });
    });

    test('an unfiltered library that could not be read at all is not an empty library', async () => {
        const failed = makeDeps(
            reading([], (opts) => {
                if (opts.readState && !opts.search) opts.readState.firstPageFailed = true;
            }),
        );
        await expect(scan(failed)).resolves.toEqual({ eligible: 0, complete: false, firstReason: 'no-eligible-photo' });
    });
});

describe('a scan leaves nothing a later real fill would notice', () => {
    const skipLines = () => lines.filter((line) => line.message.includes('Submit Only Chosen Photos is on'));

    test.each([
        ['every chosen photo already entered', ['existing'], [photo('a')], 'every chosen photo is already entered'],
        ['no chosen photo usable', ['missing'], [photo('a')], 'none of your chosen photos'],
    ])('%s: a scan, then a real fill still logs its first skip line', async (_name, chosen, library, wording) => {
        const settings = makeSettings({ chosen, only: true });
        const challenge = makeChallenge();
        await scan(makeDeps(reading(library), { settings }), challenge);
        expect(skipLines()).toEqual([]);

        const fillDeps = makeDeps(reading(library), { settings });
        await submitNewEntryForAction(challenge, 'tok', fillDeps);
        expect(skipLines()).toEqual([
            expect.objectContaining({
                category: 'autoSubmit',
                level: 'warning',
                message: expect.stringContaining(wording),
            }),
        ]);
        expect(skipLines()[0].message.startsWith('fillNew:')).toBe(true);
        // and the latch is the real fill's: it is not repeated, as before
        await submitNewEntryForAction(challenge, 'tok', fillDeps);
        expect(skipLines()).toHaveLength(1);
    });

    test("a scan between two fills neither repeats nor clears the first fill's skip line", async () => {
        const settings = makeSettings({ chosen: ['existing'], only: true });
        const challenge = makeChallenge();
        const deps = makeDeps(reading([photo('a')]), { settings });
        await submitNewEntryForAction(challenge, 'tok', deps);
        expect(skipLines()).toHaveLength(1);
        // a scan that finds a usable chosen photo would clear the latch if it touched it
        await scan(
            makeDeps(reading([photo('a')]), { settings: makeSettings({ chosen: ['a'], only: true }) }),
            challenge,
        );
        await submitNewEntryForAction(challenge, 'tok', deps);
        expect(skipLines()).toHaveLength(1);
    });

    test("every line a scan writes carries the scenarioScan label and category, never a fill's", async () => {
        await scan(makeDeps(reading([photo('a'), photo('b')])));
        await scan(makeDeps(reading([])));
        await scan(
            makeDeps(() => {
                throw new Error('library down');
            }),
        );
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line.category).toBe('scenarioScan');
            expect(line.message).not.toMatch(/^(autoSubmit|fillNew|manualFill|emergencySubmit):/);
        }
        expect(lines.some((line) => line.message.startsWith('scenarioScan:'))).toBe(true);
    });
});
