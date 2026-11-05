import type { FillLogger } from '../../src/ts/core/types/autoFill';
import type { JointInput, VoteStat } from '../../src/ts/core/services/photoPicker/jointRank';
import { invalid } from '../helpers/invalid';
import { createNodePlatform, extractedVisionRootOf, __resetExtractedRootForTests } from '../../src/ts/platforms/node';
import { installHeadlessTestPlatform, installTestPlatform, installWebviewTestPlatform } from '../helpers/platform';

import type { PlatformWindows } from '../../src/ts/core/platform/port';

/** The mocked transformers `env`: the module writes arbitrary config keys onto it. */
type MockEnv = { backends: { onnx: { wasm: object } }; localModelPath?: string; [key: string]: unknown };

// The node family answers its location from these inputs: the version flag
// its Electron check reads (set through setElectron), and the packaged answer
// its guarded electron read takes from the mocked electron module.
const runtimeFlags = { packaged: true };
const setElectron = (on: boolean) => {
    if (on) (process.versions as { electron?: string }).electron = '43.0.0';
    else delete (process.versions as { electron?: string }).electron;
};
const mockSea = { isSea: jest.fn(() => false), getAsset: jest.fn(() => 'sha') };
const mockClassifier = jest.fn();
const mockLog = { warning: jest.fn() };
const mockTransformers = {
    env: { backends: { onnx: { wasm: {} } } } as MockEnv,
    pipeline: jest.fn(async () => mockClassifier),
};
const mockSeaTransformers = {
    env: { backends: { onnx: { wasm: {} } } } as MockEnv,
    pipeline: jest.fn(async () => mockClassifier),
};
const mockCreateRequire = jest.fn(() => () => mockSeaTransformers);
const mockExtract = jest.fn(() => ({ root: '/vision/root', modulePath: '/vision/root/vision-entry.js' }));

jest.mock('path', () => jest.requireActual<typeof import('path')>('path'));
// The packaged answer is the node family's paths member now (its guarded
// electron read), so the electron module answers through the same flags.
jest.mock('electron', () => ({
    __esModule: true,
    app: {
        get isPackaged() {
            return runtimeFlags.packaged;
        },
    },
}));
jest.mock('../../src/ts/core/logger', () => ({ withCategory: jest.fn(() => mockLog) }));
jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('node:module', () => ({ createRequire: mockCreateRequire }));
jest.mock('@huggingface/transformers', () => mockTransformers);

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import type * as visionVerifierModule from '../../src/ts/core/services/visionVerifier';
const {
    rankVisually,
    hasBundledModel,
    orderByVisualFit,
    challengePrompts,
    descriptionLead,
    snapPrompts,
    judgeSnapImage,
    judgeSnapVideoFrames,
    __resetForTests,
} = require('../../src/ts/core/services/visionVerifier') as typeof visionVerifierModule;

// The service's windows: the explicit no-ops its shell module passes.
const windows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

/**
 * The node platform with the CLI's extractor injected, as the CLI shell
 * installs it: its transformers load extracts through the mock and remembers
 * the root, which the shell's location override answers.
 */
const installNodePlatformWithExtractor = (): void => {
    const installed = installTestPlatform();
    const family = createNodePlatform(windows, { extractVisionCliAssets: () => mockExtract() });
    const nodeModelLocation = family.assets.visionModel.location;
    installed.assets = {
        ...family.assets,
        visionModel: {
            ...family.assets.visionModel,
            location: () => {
                const root = extractedVisionRootOf();
                return root === undefined ? nodeModelLocation() : `${root}${path.sep}`;
            },
        },
    };
};

const hex = (seed: string) => seed.repeat(32).slice(0, 32);
const photo = (id: string) => ({ id: hex(id), member_id: hex('f') });
const LEAVES = {
    id: 'c1',
    title: 'Glorious Green Leaves',
    welcome_message: 'show us some green leaves. Join our challenge and earn rewards! * Participation reward: 10 coins',
};
const PROMPTS = ['a photo of glorious green leaves', 'show us some green leaves.'];
const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit));

const makeLogger = () => {
    const scoped = { info: jest.fn(), warning: jest.fn(), debug: jest.fn() };
    return invalid<FillLogger & { scoped: typeof scoped }>({
        scoped,
        withCategory: jest.fn(() => scoped),
        challengeTag: jest.fn(() => '[Challenge c1: Leaves]'),
    });
};

/** What a pick's tier values and votes look like when nothing but the model's fit tells the photos apart. */
const tierInput = (overrides: Partial<JointInput> = {}): JointInput => ({
    themeMatch: true,
    shouldMatchCount: 0,
    semantic: 70,
    semanticSupport: 3,
    score: 2,
    suggested: false,
    ...overrides,
});
const inputsFor = (seeds: string[], overrides: Record<string, Partial<JointInput>> = {}) =>
    new Map(seeds.map((seed) => [hex(seed), tierInput(overrides[seed])]));
const noVotes = () => jest.fn(async (): Promise<Map<string, VoteStat>> => new Map());
/** The joint arguments of a call that does not care about the joint step. */
const joint = (seeds = ['a', 'b', 'c']) => ({ jointInputs: inputsFor(seeds), loadVotes: noVotes() });

// Logits per photo seed, one per prompt, returned as the pipeline does:
// [{label, score}] sorted by score.
const logitsBy = (table: Record<string, number[]>) =>
    mockClassifier.mockImplementation(async (url: string, prompts: string[]) => {
        const seed = Object.keys(table).find((key) => url.includes(`3_${hex(key)}`));
        return prompts
            .map((label, index) => ({ label, score: sigmoid(table[seed!][index]) }))
            .sort((a, b) => b.score - a.score);
    });

beforeEach(() => {
    __resetForTests();
    __resetExtractedRootForTests();
    jest.clearAllMocks();
    setElectron(true);
    runtimeFlags.packaged = true;
    mockSea.isSea.mockReturnValue(false);
    mockSea.getAsset.mockReturnValue('sha');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    global.fetch = invalid(jest.fn(async () => ({ ok: true })));
    // Reset in place: the dynamic-import interop keeps a reference to the
    // original env object, so replacing it would hide the module's writes.
    for (const { env } of [mockTransformers, mockSeaTransformers]) {
        for (const key of Object.keys(env)) if (key !== 'backends') delete env[key];
        env.backends.onnx.wasm = {};
    }
    (process as { resourcesPath?: string }).resourcesPath = '/app/resources';
    // The node test platform stands (the setup installed it); a test that
    // swapped it gets it back from the setup's afterEach.
});

afterEach(() => {
    setElectron(false);
});

afterAll(() => {
    delete (process as { resourcesPath?: string }).resourcesPath;
    delete (global as { fetch?: typeof fetch }).fetch;
    jest.restoreAllMocks();
});

describe('descriptionLead', () => {
    test('keeps the opening sentences and drops markup, entities and the rewards text', () => {
        expect(
            descriptionLead(
                '<p>Share your best photos of balloons.&nbsp;Hot air &amp; weather balloons!</p> Anything goes. Join our challenge and earn rewards!',
            ),
        ).toBe('Share your best photos of balloons. Hot air & weather balloons!');
    });

    test('is empty for missing or boilerplate-only text, and capped for long prose', () => {
        expect(descriptionLead(undefined)).toBe('');
        expect(descriptionLead('Good luck & have fun!')).toBe('');
        expect(descriptionLead(`${'word '.repeat(80)}.`).length).toBeLessThanOrEqual(200);
    });

    test('a long run of opening brackets (no tag among them) is read in linear time', () => {
        const started = Date.now();
        expect(descriptionLead(`${'<'.repeat(100_000)}Share photos of balloons.`).length).toBeLessThanOrEqual(200);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe('challengePrompts', () => {
    test('builds prompts from any challenge title and description', () => {
        expect(challengePrompts(LEAVES)).toEqual(PROMPTS);
        expect(challengePrompts({ title: 'Metal & Wood' })).toEqual(['a photo of metal wood']);
        expect(challengePrompts({ title: 'Color Hunt: Green' })).toEqual(['a photo of green']);
        expect(challengePrompts({ title: 'Glorious Green Leaves' }, ['glorious'])).toEqual(['a photo of green leaves']);
    });

    test('a title with no visual subject gets no prompt, even with a description', () => {
        expect(challengePrompts({ title: 'Guru of The Week', welcome_message: 'Share your freshest shots.' })).toEqual(
            [],
        );
        expect(challengePrompts({ title: 'No Humans' })).toEqual([]);
        // A letter challenge's letter phrase is a rule, not a subject.
        expect(challengePrompts({ title: 'The Letter "S"' })).toEqual([]);
        expect(challengePrompts(undefined)).toEqual([]);
    });
});

describe('orderByVisualFit', () => {
    test('moves clear off-theme photos behind the accepted ones, keeping tag order inside each group', async () => {
        // Live "Glorious Green Leaves" logits: aerial island, field walkers,
        // leaf close-up, bridge, leaf canopy.
        const scored = [
            { id: 'island', logits: [-10.31, -8.39] },
            { id: 'walkers', logits: [-10.47, -6.92] },
            { id: 'leaf', logits: [-1.69, -2.84] },
            { id: 'bridge', logits: [-12.45, -10.9] },
            { id: 'canopy', logits: [-3.52, -2.91] },
        ];
        const accepted = jest.fn<void, [Set<string>]>();
        expect(await orderByVisualFit(scored, accepted)).toEqual(['leaf', 'canopy', 'walkers', 'island', 'bridge']);
        expect(accepted).toHaveBeenCalledWith(new Set(['leaf', 'canopy']));
    });

    test('fit averages the prompts, so a title-only match cannot push out a photo that fits both', async () => {
        // Live "Smoke-Filled Scenes": the title prompt alone rated fog far
        // above the real smoke photo, which the description prompt preferred.
        const scored = [
            { id: 'smoke', logits: [-4.53, -5.55] },
            { id: 'fog', logits: [-1.05, -8.9] },
            { id: 'portrait', logits: [-11.96, -12.44] },
        ];
        expect(await orderByVisualFit(scored)).toEqual(['smoke', 'fog', 'portrait']);
    });

    test('abstains when no photo clearly matches any prompt, or nothing was scored', async () => {
        // Live "It's all About Balance": best photo peaked at -7.78.
        const accepted = jest.fn<void, [Set<string>]>();
        expect(
            await orderByVisualFit(
                [
                    { id: 'stairs', logits: [-7.97] },
                    { id: 'rose', logits: [-11.17] },
                ],
                accepted,
            ),
        ).toBeNull();
        // The model could not judge the theme: that is no evidence, not a rejection.
        expect(accepted).not.toHaveBeenCalled();
        expect(await orderByVisualFit([])).toBeNull();
    });
});

describe('rankVisually', () => {
    const ids = ['a', 'b', 'c'].map(hex);
    const eligible = ['a', 'b', 'c'].map(photo);

    test('promotes the on-theme photo and loads the model from packaged resources once', async () => {
        logitsBy({ a: [-10.3, -8.4], b: [-1.7, -2.8], c: [-3.5, -2.9] });
        const logger = makeLogger();

        const onVisualEvidence = jest.fn<void, [Set<string>]>();
        expect(await rankVisually(LEAVES, ids, eligible, 2, { logger, onVisualEvidence, ...joint() })).toEqual([
            hex('b'),
            hex('c'),
        ]);
        expect(onVisualEvidence).toHaveBeenCalledWith(new Set([hex('b'), hex('c')]));
        expect(mockClassifier).toHaveBeenCalledWith(expect.stringContaining('/256x256/'), PROMPTS);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            `Visual check re-ranked picks for [Challenge c1: Leaves]: ${hex('a')}, ${hex('b')} → ${hex('b')}, ${hex('c')}`,
            {
                prompts: PROMPTS,
                scores: expect.arrayContaining([{ id: hex('b'), logits: [expect.any(Number), -2.8] }]),
                joint: {
                    [hex('b')]: { theme_n: expect.any(Number), vision_n: 1, votes_n: 0.5, joint: expect.any(Number) },
                    [hex('c')]: {
                        theme_n: expect.any(Number),
                        vision_n: expect.any(Number),
                        votes_n: 0.5,
                        joint: expect.any(Number),
                    },
                },
            },
        );
        expect(mockTransformers.env).toMatchObject({
            allowRemoteModels: false,
            allowLocalModels: true,
            localModelPath: `/app/resources${path.sep}`,
        });
        expect(mockTransformers.pipeline).toHaveBeenCalledWith('zero-shot-image-classification', 'vision-model', {
            dtype: 'q8',
            device: 'cpu',
        });

        await rankVisually(LEAVES, ids, eligible, 1, { logger, ignoreWords: ['glorious'], ...joint() });
        expect(mockTransformers.pipeline).toHaveBeenCalledTimes(1);
        expect(mockClassifier).toHaveBeenLastCalledWith(expect.any(String), [
            'a photo of green leaves',
            'show us some green leaves.',
        ]);
    });

    test('only the head of a long ranking is scored; the tail still backs a large pick', async () => {
        const long = [...'0123456789abcd'].map(hex);
        const photos = long.map((id) => ({ id, member_id: hex('f') }));
        mockClassifier.mockImplementation(async (url: string, prompts: string[]) =>
            prompts.map((label) => ({ label, score: 0.1 })),
        );
        const picked = await rankVisually(LEAVES, long, photos, 13, { logger: makeLogger(), ...joint() });
        expect(mockClassifier).toHaveBeenCalledTimes(13);
        expect(picked).toEqual(long.slice(0, 13));
    });

    test('an unchanged pick records the model scores', async () => {
        logitsBy({ a: [-2, -2], b: [-2.5, -2.5], c: [-9, -9] });
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger, ...joint() })).toEqual([hex('a')]);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            'Visual check kept pick order for [Challenge c1: Leaves]: no replacement ranked higher',
            {
                prompts: PROMPTS,
                scores: expect.arrayContaining([{ id: hex('a'), logits: [-2, -2] }]),
                joint: { [hex('a')]: expect.any(Object), [hex('b')]: expect.any(Object) },
            },
        );
    });

    test.each([
        ['a title with no visual subject', { title: 'Photo of the Day' }, ids],
        ['an empty ranking', LEAVES, []],
        ['a letter challenge (the letter phrase is not a subject)', { title: 'The Letter "S"' }, ids],
    ])('%s keeps the tag order without loading the model', async (_name, challenge, ranked) => {
        expect(await rankVisually(challenge, ranked, eligible, 1, { logger: makeLogger(), ...joint() })).toEqual(
            ranked.slice(0, 1),
        );
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('a candidate without a buildable photo URL keeps the tag order', async () => {
        const withBroken = [...eligible, { id: 'not-an-md5', member_id: hex('f') }];
        expect(
            await rankVisually(LEAVES, [...ids, 'not-an-md5'], withBroken, 1, { logger: makeLogger(), ...joint() }),
        ).toEqual([hex('a')]);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('abstains to the tag order when nothing matches the prompts', async () => {
        logitsBy({ a: [-9, -9], b: [-8, -8], c: [-12, -12] });
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger, ...joint() })).toEqual([hex('a')]);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            'Visual check abstained for [Challenge c1: Leaves]; kept tag order',
            { prompts: PROMPTS, scores: expect.arrayContaining([{ id: hex('b'), logits: [-8, -8] }]) },
        );
    });

    test.each([[undefined], [{}], [[]], [[{ label: 'something else', score: 0.5 }]]])(
        'an unusable classifier result %p keeps the tag order',
        async (output) => {
            mockClassifier.mockResolvedValue(output);
            expect(await rankVisually(LEAVES, ids, eligible, 1, { logger: makeLogger(), ...joint() })).toEqual([
                hex('a'),
            ]);
        },
    );

    test.each([
        [new Error('onnx missing'), 'onnx missing'],
        ['bare failure', 'bare failure'],
        [null, 'null'],
    ])('a model load failure (%p) keeps the tag order and warns', async (failure, detail) => {
        mockTransformers.pipeline.mockRejectedValueOnce(failure);
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger, ...joint() })).toEqual([hex('a')]);
        expect(logger.scoped.warning).toHaveBeenCalledWith(
            `Visual check unavailable for [Challenge c1: Leaves]: ${detail}`,
            null,
        );
    });

    test.each([
        ['Capacitor', () => installWebviewTestPlatform()],
        ['the headless service', () => installHeadlessTestPlatform()],
    ])('%s runs single-threaded WASM from the WebView origin', async (_name, arrange) => {
        arrange();
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger(), ...joint() });
        expect(mockTransformers.env.localModelPath).toBe('./');
        expect(mockTransformers.env.backends.onnx.wasm).toEqual({ wasmPaths: './', numThreads: 1 });
        expect(mockTransformers.pipeline).toHaveBeenCalledWith('zero-shot-image-classification', 'vision-model', {
            dtype: 'q8',
            device: 'wasm',
        });
    });

    describe('the joint step', () => {
        // The logged "Everything Sports" join (2026-11-03): the model's logits for the 12 shortlisted photos,
        // in the tier order the pick was ranked in. 41d4 (golf, 5,470 votes) led the accepted group under the
        // old order; 6f26 (soccer, 68,596 votes) fits best of all.
        const SPORTS = {
            id: '137654',
            title: 'Everything Sports',
            welcome_message: 'Share your best photos of sports. Athletes, a soccer game, playing golf, swimming.',
        };
        const LOGGED: Record<string, number[]> = {
            '9': [-8.25400921238462, -11.180912938953927],
            '4': [-3.910000802633653, -6.20046662189218],
            '6': [-2.647967318348275, -5.779306397868556],
            '2': [-4.80815309799085, -6.320335405006422],
            e: [-5.452210887308753, -7.352216709486179],
            '0': [-6.53552153938595, -8.245462425355221],
            '5': [-6.382664647645, -8.401554106574784],
            '7': [-7.357165791949786, -8.261360175550559],
            '8': [-9.153389007315798, -10.056156146631611],
            '1': [-10.023301095037032, -12.202523274358844],
            f: [-12.089464186061774, -14.966932254564744],
            d: [-11.443315521565099, -14.283918423333319],
        };
        // The shortlist's logged order: 9942, 41d4, 6f26, 0c9b, 284c, 6559, 087d, 68cd, 8b4b, 1d4c, f44e, ea46.
        const seeds = ['9', '4', '6', '0', '2', '5', '7', 'd', '8', '1', 'f', 'e'];
        // Step 0 of the plan: shouldMatchCount 0, semantic bucket 76, support 3 (e: 2), lexical 3 (2: 2).
        const tiers = inputsFor(seeds, {
            '9': { semantic: 76, score: 3 },
            '4': { semantic: 76, score: 3 },
            '6': { semantic: 76, score: 3 },
            '2': { semantic: 76, score: 2 },
            e: { semantic: 76, semanticSupport: 2, score: 3 },
        });
        // The cached votes of the two photos the logs name; the other two accepted photos have no stats yet.
        const stats = new Map<string, VoteStat>([
            [hex('4'), { votes: 5470, statsKnown: true }],
            [hex('6'), { votes: 68596, statsKnown: true }],
        ]);
        const shortlist = seeds.map(hex);
        const sports = seeds.map(photo);

        test('the logged join picks the soccer photo, where the old order picked golf', async () => {
            logitsBy(LOGGED);
            const loadVotes = jest.fn(
                async (asked: string[]) =>
                    new Map(asked.filter((id) => stats.has(id)).map((id) => [id, stats.get(id)!])),
            );
            const logger = makeLogger();
            const picked = await rankVisually(SPORTS, shortlist, sports, 1, {
                logger,
                jointInputs: tiers,
                loadVotes,
            });
            expect(picked).toEqual([hex('6')]);
            // Only the four photos the model accepted are looked up.
            expect(loadVotes).toHaveBeenCalledWith([hex('4'), hex('6'), hex('2'), hex('e')]);
            const [message, detail] = logger.scoped.info.mock.calls[0] as [string, { joint: Record<string, unknown> }];
            expect(message).toBe(`Visual check re-ranked picks for [Challenge c1: Leaves]: ${hex('9')} → ${hex('6')}`);
            expect(Object.keys(detail.joint).sort()).toEqual([hex('2'), hex('4'), hex('6'), hex('e')].sort());
            // The old order: the same shortlist split by fit alone keeps the incoming order inside the accepted group.
            const split = await orderByVisualFit(seeds.map((seed) => ({ id: hex(seed), logits: LOGGED[seed] })));
            expect(split!.slice(0, 4)).toEqual([hex('4'), hex('6'), hex('2'), hex('e')]);
        });

        test('a failed votes lookup counts every photo as unknown, keeps the vision split and is logged', async () => {
            logitsBy(LOGGED);
            const logger = makeLogger();
            const picked = await rankVisually(SPORTS, shortlist, sports, 2, {
                logger,
                jointInputs: tiers,
                loadVotes: jest.fn(async () => {
                    throw new Error('stats down');
                }),
            });
            // Soccer still leads on fit; the rejected photo is not among the two.
            expect(picked).toEqual([hex('6'), hex('4')]);
            expect(logger.scoped.debug).toHaveBeenCalledWith(
                'Visual check could not read the votes for [Challenge c1: Leaves]: stats down',
                null,
            );
            expect(logger.scoped.warning).not.toHaveBeenCalled();
            expect(logger.scoped.info).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    joint: expect.objectContaining({ [hex('6')]: expect.objectContaining({ votes_n: 0.5 }) }),
                }),
            );
        });

        test('a bare rejection of the votes lookup is read as its text', async () => {
            logitsBy(LOGGED);
            const logger = makeLogger();
            await rankVisually(SPORTS, shortlist, sports, 1, {
                logger,
                jointInputs: tiers,
                loadVotes: jest.fn(() => Promise.reject('plain failure')),
            });
            expect(logger.scoped.debug).toHaveBeenCalledWith(
                'Visual check could not read the votes for [Challenge c1: Leaves]: plain failure',
                null,
            );
        });

        test('one accepted photo asks for no votes, and a reorder by the split alone is logged', async () => {
            // b is the only photo within the margin; the rejected a was ranked first.
            logitsBy({ a: [-9, -9], b: [-1, -1], c: [-8, -8] });
            const loadVotes = noVotes();
            const logger = makeLogger();
            expect(
                await rankVisually(LEAVES, ids, eligible, 1, {
                    logger,
                    jointInputs: inputsFor(['a', 'b', 'c']),
                    loadVotes,
                }),
            ).toEqual([hex('b')]);
            expect(loadVotes).not.toHaveBeenCalled();
            expect(logger.scoped.info).toHaveBeenCalledWith(
                `Visual check re-ranked picks for [Challenge c1: Leaves]: ${hex('a')} → ${hex('b')}`,
                expect.objectContaining({ joint: {} }),
            );
        });

        test.each([
            ['abstains', { a: [-9, -9], b: [-8, -8], c: [-12, -12] }],
            ['finds no visual subject', null],
        ])('a model that %s asks for no votes and keeps the tag order', async (_name, table) => {
            const loadVotes = noVotes();
            const challenge = table ? LEAVES : { title: 'Photo of the Day' };
            if (table) logitsBy(table);
            expect(
                await rankVisually(challenge, ids, eligible, 2, {
                    logger: makeLogger(),
                    jointInputs: inputsFor(['a']),
                    loadVotes,
                }),
            ).toEqual(ids.slice(0, 2));
            expect(loadVotes).not.toHaveBeenCalled();
        });

        test('a model error keeps the tag order and asks for no votes', async () => {
            mockTransformers.pipeline.mockRejectedValueOnce(new Error('onnx missing'));
            const loadVotes = noVotes();
            expect(
                await rankVisually(LEAVES, ids, eligible, 2, {
                    logger: makeLogger(),
                    jointInputs: inputsFor(['a']),
                    loadVotes,
                }),
            ).toEqual(ids.slice(0, 2));
            expect(loadVotes).not.toHaveBeenCalled();
        });

        test('the gates hold: an unmatched accepted photo with the top fit and votes stays behind a matched one', async () => {
            logitsBy({ a: [-1, -1], b: [-2, -2], c: [-9, -9] });
            const votes = new Map<string, VoteStat>([
                [hex('a'), { votes: 90000, statsKnown: true }],
                [hex('b'), { votes: 10, statsKnown: true }],
            ]);
            const picked = await rankVisually(LEAVES, ids, eligible, 2, {
                logger: makeLogger(),
                jointInputs: inputsFor(['a', 'b', 'c'], {
                    a: { themeMatch: false, semantic: 0, semanticSupport: 0, score: 0 },
                }),
                loadVotes: jest.fn(async () => votes),
            });
            expect(picked).toEqual([hex('b'), hex('a')]);
        });
    });

    test('the SEA CLI loads transformers and the model from its extracted runtime', async () => {
        installNodePlatformWithExtractor();
        setElectron(false);
        mockSea.isSea.mockReturnValue(true);
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger(), ...joint() });
        expect(mockExtract).toHaveBeenCalled();
        expect(mockCreateRequire).toHaveBeenCalledWith('/vision/root/vision-entry.js');
        expect(mockSeaTransformers.env.localModelPath).toBe(`/vision/root${path.sep}`);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('a failed integrity check is not kept: the next call extracts and loads again', async () => {
        installNodePlatformWithExtractor();
        setElectron(false);
        mockSea.isSea.mockReturnValue(true);
        mockExtract.mockImplementationOnce(() => {
            throw new Error('Vision runtime failed its integrity check');
        });
        logitsBy({ a: [-2, -2] });
        const logger = makeLogger();

        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger, ...joint() });
        expect(logger.scoped.warning).toHaveBeenCalled();
        expect(mockSeaTransformers.pipeline).not.toHaveBeenCalled();

        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger, ...joint() });
        expect(mockExtract).toHaveBeenCalledTimes(2);
        expect(mockSeaTransformers.pipeline).toHaveBeenCalledTimes(1);
    });

    test.each([
        [
            'a source-run CLI',
            () => {
                setElectron(false);
            },
        ],
        [
            'unpackaged Electron',
            () => {
                runtimeFlags.packaged = false;
            },
        ],
    ])('%s reads the build cache under the repository root', async (_name, arrange) => {
        arrange();
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger(), ...joint() });
        expect(mockExtract).not.toHaveBeenCalled();
        expect(mockTransformers.env.localModelPath).toBe(path.join(__dirname, '..', '..', '.cache') + path.sep);
    });

    test('a lite build without the model keeps the tag order quietly and checks only once', async () => {
        fs.existsSync.mockReturnValue(false);
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger, ...joint() })).toEqual([hex('a')]);
        await rankVisually(LEAVES, ids, eligible, 1, { logger, ...joint() });
        expect(fs.existsSync).toHaveBeenCalledTimes(1);
        expect(fs.existsSync).toHaveBeenCalledWith(
            path.join(`/app/resources${path.sep}`, 'vision-model', 'config.json'),
        );
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
        expect(logger.scoped.warning).not.toHaveBeenCalled();
    });
});

describe('the family remembers the extracted SEA runtime root', () => {
    test('the root is answered once the transformers load has extracted it', async () => {
        expect(extractedVisionRootOf()).toBeUndefined();
        installNodePlatformWithExtractor();
        mockSea.isSea.mockReturnValue(true);
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger(), ...joint() });
        expect(extractedVisionRootOf()).toBe('/vision/root');
    });
});

describe('hasBundledModel', () => {
    test.each([
        ['serves the model config', async () => ({ ok: true }), true],
        ['answers 404', async () => ({ ok: false }), false],
        ['cannot fetch at all', async () => Promise.reject(new Error('offline')), false],
    ])('the Android WebView sees the model when its webDir %s', async (_name, response, expected) => {
        installWebviewTestPlatform();
        jest.mocked(global.fetch).mockImplementation(invalid(response));
        expect(await hasBundledModel()).toBe(expected);
        expect(global.fetch).toHaveBeenCalledWith('vision-model/config.json');
    });

    test('the SEA CLI looks for the embedded runtime asset', async () => {
        mockSea.isSea.mockReturnValue(true);
        expect(await hasBundledModel()).toBe(true);
        expect(mockSea.getAsset).toHaveBeenCalledWith('vision-runtime.sha256');

        __resetForTests();
        mockSea.getAsset.mockImplementation(() => {
            throw new Error('ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND');
        });
        expect(await hasBundledModel()).toBe(false);
        expect(fs.existsSync).not.toHaveBeenCalled();
    });

    test('a source-run CLI checks the build cache', async () => {
        setElectron(false);
        fs.existsSync.mockReturnValue(false);
        expect(await hasBundledModel()).toBe(false);
        expect(fs.existsSync).toHaveBeenCalledWith(
            path.join(path.join(__dirname, '..', '..', '.cache') + path.sep, 'vision-model', 'config.json'),
        );
    });
});

describe('snapPrompts', () => {
    const POSITIVE_NO = 'artificial, fake and over-edited';
    const NEGATIVE_NO = 'natural and realistic';

    test.each([
        [
            'Do the colored / neon lights and their reflections look natural?',
            'colored / neon lights and their reflections',
            'natural',
            POSITIVE_NO,
        ],
        ['Does the soft, even light look natural?', 'soft, even light', 'natural', POSITIVE_NO],
        [
            '  Does the dramatic low light and shadow look natural?  ',
            'dramatic low light and shadow',
            'natural',
            POSITIVE_NO,
        ],
        [
            'Do the light rays and shadows look natural and believable?',
            'light rays and shadows',
            'natural and believable',
            POSITIVE_NO,
        ],
        ['Are the colors seem Realistic?', 'colors', 'Realistic', POSITIVE_NO],
        ['Does the sky look fake?', 'sky', 'fake', NEGATIVE_NO],
        ['Do the edges look over-edited?', 'edges', 'over-edited', NEGATIVE_NO],
        ['Does the sky look un-natural?', 'sky', 'un-natural', NEGATIVE_NO],
    ])('%s', (caption, subject, predicate, no) => {
        expect(snapPrompts(caption)).toEqual({
            yes: `a photo where the ${subject} look ${predicate}`,
            no: `a photo where the ${subject} look ${no}`,
        });
    });

    test.each([
        ['an unknown predicate', 'Does the soft light look dramatic?'],
        ['a predicate that only contains a known word', 'Does the light look supernatural?'],
        ['a negated predicate', 'Does the light look natural, not over-edited?'],
        ['a predicate with a negative and a positive word', 'Does the light look natural but fake?'],
        ['a statement', 'The soft light looks natural.'],
        ['an empty caption', ''],
        ['a caption over 200 characters', `Does the ${'soft '.repeat(50)}light look natural?`],
    ])('%s is not understood', (_name, caption) => {
        expect(snapPrompts(caption)).toBeNull();
    });
});

describe('judgeSnapImage', () => {
    const CAPTION = 'Does the soft, even light look natural?';
    const prompts = snapPrompts(CAPTION)!;
    const image = { imageId: hex('a'), memberId: hex('f') };
    const scores = (yes: number, no: number) =>
        mockClassifier.mockResolvedValue([
            { label: prompts.yes, score: sigmoid(yes) },
            { label: prompts.no, score: sigmoid(no) },
        ]);

    test('answers yes when the yes prompt has the higher logit', async () => {
        scores(1.5, -0.5);
        const judgment = await judgeSnapImage(CAPTION, image);
        expect(judgment).toEqual({ answer: 'yes', yesLogit: expect.closeTo(1.5), noLogit: expect.closeTo(-0.5) });
        expect(mockClassifier).toHaveBeenCalledWith(expect.stringContaining('/fit-in/512x512/'), [
            prompts.yes,
            prompts.no,
        ]);
    });

    test('answers no when the no prompt has the higher logit, and yes on a tie', async () => {
        scores(-2, 0.5);
        expect(await judgeSnapImage(CAPTION, image)).toEqual(expect.objectContaining({ answer: 'no' }));
        scores(1, 1);
        expect(await judgeSnapImage(CAPTION, image)).toEqual(expect.objectContaining({ answer: 'yes' }));
    });

    test('is null for a caption it does not understand or a photo with no URL, without loading the model', async () => {
        expect(await judgeSnapImage('Is it Tuesday?', image)).toBeNull();
        expect(await judgeSnapImage(CAPTION, { imageId: 'not-an-md5', memberId: hex('f') })).toBeNull();
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('is null when the model is not bundled', async () => {
        fs.existsSync.mockReturnValue(false);
        expect(await judgeSnapImage(CAPTION, image)).toBeNull();
        expect(mockClassifier).not.toHaveBeenCalled();
    });

    test.each([[undefined], [[]], [[{ label: 'something else', score: 0.5 }]]])(
        'an unusable classifier result %p is null and warns',
        async (output) => {
            mockClassifier.mockResolvedValue(output);
            expect(await judgeSnapImage(CAPTION, image)).toBeNull();
            expect(mockLog.warning).toHaveBeenCalledWith('Snap judgment found invalid model scores', null);
        },
    );

    test.each([
        [new Error('onnx missing'), 'onnx missing'],
        [null, 'null'],
    ])('a classifier failure (%p) is null and warns', async (failure, detail) => {
        mockClassifier.mockRejectedValue(failure);
        expect(await judgeSnapImage(CAPTION, image)).toBeNull();
        expect(mockLog.warning).toHaveBeenCalledWith(`Snap judgment unavailable: ${detail}`, null);
    });
});

describe('judgeSnapVideoFrames', () => {
    test('uses the highest category per frame, keeps a lower tie, then maps and rounds the mean', async () => {
        const winners = [0, 3, 6];
        let frame = 0;
        mockClassifier.mockImplementation(async (_image: Blob, prompts: string[]) => {
            const winner = winners[frame++];
            return prompts.map((label, index) => ({
                label,
                score: index === winner || (frame === 1 && index === 6) ? 0.9 : 0.1,
            }));
        });

        const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
        expect(await judgeSnapVideoFrames('Rate overall picture quality.', [jpeg, jpeg, jpeg], 7)).toBe(4);
        expect(mockClassifier).toHaveBeenCalledTimes(3);
        const classifierCalls = mockClassifier.mock.calls as Array<[Blob, string[]]>;
        for (const [image, prompts] of classifierCalls) {
            expect(image).toBeInstanceOf(Blob);
            expect((await image.arrayBuffer()).byteLength).toBe(4);
            expect(prompts).toHaveLength(7);
            expect(prompts.every((prompt: string) => prompt.includes('Rate overall picture quality.'))).toBe(true);
        }
    });

    test('rejects a missing or non-finite model score', async () => {
        mockClassifier.mockResolvedValue([{ label: 'unusable picture. Server caption: Rate it.', score: Number.NaN }]);
        const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
        expect(await judgeSnapVideoFrames('Rate it.', [jpeg, jpeg, jpeg], 7)).toBeNull();
    });

    test.each([
        [
            'not a JPEG data URL',
            ['data:image/png;base64,AA==', 'data:image/png;base64,AA==', 'data:image/png;base64,AA=='],
        ],
        ['an empty JPEG data URL', ['data:image/jpeg;base64,', 'data:image/jpeg;base64,', 'data:image/jpeg;base64,']],
        [
            'invalid JPEG base64',
            ['data:image/jpeg;base64,!!!', 'data:image/jpeg;base64,!!!', 'data:image/jpeg;base64,!!!'],
        ],
        ['an invalid frame count', ['data:image/jpeg;base64,/9j/2Q==']],
    ])('rejects %s before classifier inference', async (_name, frames) => {
        expect(await judgeSnapVideoFrames('Rate it.', frames, 7)).toBeNull();
        expect(mockClassifier).not.toHaveBeenCalled();
    });

    test.each([1, 11, 2.5])('rejects invalid score scale %p', async (maxScore) => {
        const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
        expect(await judgeSnapVideoFrames('Rate it.', [jpeg, jpeg, jpeg], maxScore)).toBeNull();
        expect(mockClassifier).not.toHaveBeenCalled();
    });

    test('rejects a model-free build and classifier exceptions', async () => {
        const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
        fs.existsSync.mockReturnValue(false);
        expect(await judgeSnapVideoFrames('Rate it.', [jpeg, jpeg, jpeg], 7)).toBeNull();
        expect(mockClassifier).not.toHaveBeenCalled();

        fs.existsSync.mockReturnValue(true);
        __resetForTests();
        mockClassifier.mockRejectedValueOnce(new Error('inference failed'));
        expect(await judgeSnapVideoFrames('Rate it.', [jpeg, jpeg, jpeg], 7)).toBeNull();
        expect(mockLog.warning).toHaveBeenCalledWith('Snap video judgment unavailable: inference failed', null);
        __resetForTests();
        mockClassifier.mockRejectedValueOnce(null);
        expect(await judgeSnapVideoFrames('Rate it.', [jpeg, jpeg, jpeg], 7)).toBeNull();
        expect(mockLog.warning).toHaveBeenCalledWith('Snap video judgment unavailable: null', null);
    });
});
