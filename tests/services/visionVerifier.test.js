const mockRuntime = {
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
    isCli: jest.fn(() => false),
    isElectron: jest.fn(() => true),
    isPackaged: jest.fn(() => true),
};
const mockSea = { isSea: jest.fn(() => false), getAsset: jest.fn(() => 'sha') };
const mockClassifier = jest.fn();
const mockTransformers = {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: jest.fn(async () => mockClassifier),
};
const mockSeaTransformers = {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: jest.fn(async () => mockClassifier),
};
const mockCreateRequire = jest.fn(() => () => mockSeaTransformers);
const mockExtract = jest.fn(() => ({ root: '/vision/root', modulePath: '/vision/root/vision-entry.js' }));

jest.mock('path', () => jest.requireActual('path'));
jest.mock('../../src/js/runtime', () => mockRuntime);
jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('node:module', () => ({ createRequire: mockCreateRequire }));
jest.mock('@huggingface/transformers', () => mockTransformers);
jest.mock('../../src/js/services/visionCliAssets', () => ({ extractVisionCliAssets: mockExtract }));

const fs = require('node:fs');
const path = require('node:path');
const {
    rankVisually,
    hasBundledModel,
    orderByVisualFit,
    challengePrompts,
    descriptionLead,
    __resetForTests,
} = require('../../src/js/services/visionVerifier');

const hex = (seed) => seed.repeat(32).slice(0, 32);
const photo = (id) => ({ id: hex(id), member_id: hex('f') });
const LEAVES = {
    id: 'c1',
    title: 'Glorious Green Leaves',
    welcome_message: 'show us some green leaves. Join our challenge and earn rewards! * Participation reward: 10 coins',
};
const PROMPTS = ['a photo of glorious green leaves', 'show us some green leaves.'];
const sigmoid = (logit) => 1 / (1 + Math.exp(-logit));

const makeLogger = () => {
    const scoped = { info: jest.fn(), warning: jest.fn() };
    return { scoped, withCategory: jest.fn(() => scoped), challengeTag: jest.fn(() => '[Challenge c1: Leaves]') };
};

// Logits per photo seed, one per prompt, returned as the pipeline does:
// [{label, score}] sorted by score.
const logitsBy = (table) =>
    mockClassifier.mockImplementation(async (url, prompts) => {
        const seed = Object.keys(table).find((key) => url.includes(`3_${hex(key)}`));
        return prompts
            .map((label, index) => ({ label, score: sigmoid(table[seed][index]) }))
            .sort((a, b) => b.score - a.score);
    });

beforeEach(() => {
    __resetForTests();
    jest.clearAllMocks();
    mockRuntime.isCapacitor.mockReturnValue(false);
    mockRuntime.isHeadlessService.mockReturnValue(false);
    mockRuntime.isCli.mockReturnValue(false);
    mockRuntime.isElectron.mockReturnValue(true);
    mockRuntime.isPackaged.mockReturnValue(true);
    mockSea.isSea.mockReturnValue(false);
    mockSea.getAsset.mockReturnValue('sha');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    global.fetch = jest.fn(async () => ({ ok: true }));
    // Reset in place: the dynamic-import interop keeps a reference to the
    // original env object, so replacing it would hide the module's writes.
    for (const { env } of [mockTransformers, mockSeaTransformers]) {
        for (const key of Object.keys(env)) if (key !== 'backends') delete env[key];
        env.backends.onnx.wasm = {};
    }
    process.resourcesPath = '/app/resources';
});

afterAll(() => {
    delete process.resourcesPath;
    delete global.fetch;
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
        expect(challengePrompts(undefined)).toEqual([]);
    });
});

describe('orderByVisualFit', () => {
    test('moves clear off-theme photos behind the accepted ones, keeping tag order inside each group', () => {
        // Live "Glorious Green Leaves" logits: aerial island, field walkers,
        // leaf close-up, bridge, leaf canopy.
        const scored = [
            { id: 'island', logits: [-10.31, -8.39] },
            { id: 'walkers', logits: [-10.47, -6.92] },
            { id: 'leaf', logits: [-1.69, -2.84] },
            { id: 'bridge', logits: [-12.45, -10.9] },
            { id: 'canopy', logits: [-3.52, -2.91] },
        ];
        expect(orderByVisualFit(scored)).toEqual(['leaf', 'canopy', 'walkers', 'island', 'bridge']);
    });

    test('fit averages the prompts, so a title-only match cannot push out a photo that fits both', () => {
        // Live "Smoke-Filled Scenes": the title prompt alone rated fog far
        // above the real smoke photo, which the description prompt preferred.
        const scored = [
            { id: 'smoke', logits: [-4.53, -5.55] },
            { id: 'fog', logits: [-1.05, -8.9] },
            { id: 'portrait', logits: [-11.96, -12.44] },
        ];
        expect(orderByVisualFit(scored)).toEqual(['smoke', 'fog', 'portrait']);
    });

    test('abstains when no photo clearly matches any prompt, or nothing was scored', () => {
        // Live "It's all About Balance": best photo peaked at -7.78.
        expect(
            orderByVisualFit([
                { id: 'stairs', logits: [-7.97] },
                { id: 'rose', logits: [-11.17] },
            ]),
        ).toBeNull();
        expect(orderByVisualFit([])).toBeNull();
    });
});

describe('rankVisually', () => {
    const ids = ['a', 'b', 'c'].map(hex);
    const eligible = ['a', 'b', 'c'].map(photo);

    test('promotes the on-theme photo and loads the model from packaged resources once', async () => {
        logitsBy({ a: [-10.3, -8.4], b: [-1.7, -2.8], c: [-3.5, -2.9] });
        const logger = makeLogger();

        expect(await rankVisually(LEAVES, ids, eligible, 2, { logger })).toEqual([hex('b'), hex('c')]);
        expect(mockClassifier).toHaveBeenCalledWith(expect.stringContaining('/256x256/'), PROMPTS);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            `Visual check reordered picks for [Challenge c1: Leaves]: ${hex('a')}, ${hex('b')} → ${hex('b')}, ${hex('c')}`,
            null,
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

        await rankVisually(LEAVES, ids, eligible, 1, { logger, ignoreWords: ['glorious'] });
        expect(mockTransformers.pipeline).toHaveBeenCalledTimes(1);
        expect(mockClassifier).toHaveBeenLastCalledWith(expect.any(String), [
            'a photo of green leaves',
            'show us some green leaves.',
        ]);
    });

    test('only the head of a long ranking is scored; the tail still backs a large pick', async () => {
        const long = [...'0123456789abcd'].map(hex);
        const photos = long.map((id) => ({ id, member_id: hex('f') }));
        mockClassifier.mockImplementation(async (url, prompts) => prompts.map((label) => ({ label, score: 0.1 })));
        const picked = await rankVisually(LEAVES, long, photos, 13, { logger: makeLogger() });
        expect(mockClassifier).toHaveBeenCalledTimes(13);
        expect(picked).toEqual(long.slice(0, 13));
    });

    test('an unchanged pick logs nothing', async () => {
        logitsBy({ a: [-2, -2], b: [-2.5, -2.5], c: [-9, -9] });
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger })).toEqual([hex('a')]);
        expect(logger.scoped.info).not.toHaveBeenCalled();
    });

    test.each([
        ['a title with no visual subject', { title: 'Photo of the Day' }, ids],
        ['an empty ranking', LEAVES, []],
    ])('%s keeps the tag order without loading the model', async (_name, challenge, ranked) => {
        expect(await rankVisually(challenge, ranked, eligible, 1, { logger: makeLogger() })).toEqual(
            ranked.slice(0, 1),
        );
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('a candidate without a buildable photo URL keeps the tag order', async () => {
        const withBroken = [...eligible, { id: 'not-an-md5', member_id: hex('f') }];
        expect(await rankVisually(LEAVES, [...ids, 'not-an-md5'], withBroken, 1, { logger: makeLogger() })).toEqual([
            hex('a'),
        ]);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('abstains to the tag order when nothing matches the prompts', async () => {
        logitsBy({ a: [-9, -9], b: [-8, -8], c: [-12, -12] });
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger: makeLogger() })).toEqual([hex('a')]);
    });

    test.each([[undefined], [{}], [[]], [[{ label: 'something else', score: 0.5 }]]])(
        'an unusable classifier result %p keeps the tag order',
        async (output) => {
            mockClassifier.mockResolvedValue(output);
            expect(await rankVisually(LEAVES, ids, eligible, 1, { logger: makeLogger() })).toEqual([hex('a')]);
        },
    );

    test.each([
        [new Error('onnx missing'), 'onnx missing'],
        ['bare failure', 'bare failure'],
    ])('a model load failure (%p) keeps the tag order and warns', async (failure, detail) => {
        mockTransformers.pipeline.mockRejectedValueOnce(failure);
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger })).toEqual([hex('a')]);
        expect(logger.scoped.warning).toHaveBeenCalledWith(
            `Visual check unavailable for [Challenge c1: Leaves]: ${detail}`,
            null,
        );
    });

    test.each([
        ['Capacitor', () => mockRuntime.isCapacitor.mockReturnValue(true)],
        ['the headless service', () => mockRuntime.isHeadlessService.mockReturnValue(true)],
    ])('%s runs single-threaded WASM from the WebView origin', async (_name, arrange) => {
        arrange();
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger() });
        expect(mockTransformers.env.localModelPath).toBe('./');
        expect(mockTransformers.env.backends.onnx.wasm).toEqual({ wasmPaths: './', numThreads: 1 });
        expect(mockTransformers.pipeline).toHaveBeenCalledWith('zero-shot-image-classification', 'vision-model', {
            dtype: 'q8',
            device: 'wasm',
        });
    });

    test('the SEA CLI loads transformers and the model from its extracted runtime', async () => {
        mockRuntime.isCli.mockReturnValue(true);
        mockRuntime.isElectron.mockReturnValue(false);
        mockSea.isSea.mockReturnValue(true);
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger() });
        expect(mockExtract).toHaveBeenCalled();
        expect(mockCreateRequire).toHaveBeenCalledWith('/vision/root/vision-entry.js');
        expect(mockSeaTransformers.env.localModelPath).toBe(`/vision/root${path.sep}`);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test.each([
        [
            'a source-run CLI',
            () => {
                mockRuntime.isCli.mockReturnValue(true);
                mockRuntime.isElectron.mockReturnValue(false);
            },
        ],
        ['unpackaged Electron', () => mockRuntime.isPackaged.mockReturnValue(false)],
    ])('%s reads the build cache under the repository root', async (_name, arrange) => {
        arrange();
        logitsBy({ a: [-2, -2] });
        await rankVisually(LEAVES, [hex('a')], [photo('a')], 1, { logger: makeLogger() });
        expect(mockExtract).not.toHaveBeenCalled();
        expect(mockTransformers.env.localModelPath).toBe(path.join(__dirname, '..', '..', '.cache') + path.sep);
    });

    test('a lite build without the model keeps the tag order quietly and checks only once', async () => {
        fs.existsSync.mockReturnValue(false);
        const logger = makeLogger();
        expect(await rankVisually(LEAVES, ids, eligible, 1, { logger })).toEqual([hex('a')]);
        await rankVisually(LEAVES, ids, eligible, 1, { logger });
        expect(fs.existsSync).toHaveBeenCalledTimes(1);
        expect(fs.existsSync).toHaveBeenCalledWith(
            path.join(`/app/resources${path.sep}`, 'vision-model', 'config.json'),
        );
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
        expect(logger.scoped.warning).not.toHaveBeenCalled();
    });
});

describe('hasBundledModel', () => {
    test.each([
        ['serves the model config', async () => ({ ok: true }), true],
        ['answers 404', async () => ({ ok: false }), false],
        ['cannot fetch at all', async () => Promise.reject(new Error('offline')), false],
    ])('the Android WebView sees the model when its webDir %s', async (_name, response, expected) => {
        mockRuntime.isCapacitor.mockReturnValue(true);
        global.fetch.mockImplementation(response);
        expect(await hasBundledModel()).toBe(expected);
        expect(global.fetch).toHaveBeenCalledWith('vision-model/config.json');
    });

    test('the SEA CLI looks for the embedded runtime asset', async () => {
        mockRuntime.isCli.mockReturnValue(true);
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
        mockRuntime.isCli.mockReturnValue(true);
        mockRuntime.isElectron.mockReturnValue(false);
        fs.existsSync.mockReturnValue(false);
        expect(await hasBundledModel()).toBe(false);
        expect(fs.existsSync).toHaveBeenCalledWith(
            path.join(path.join(__dirname, '..', '..', '.cache') + path.sep, 'vision-model', 'config.json'),
        );
    });
});
