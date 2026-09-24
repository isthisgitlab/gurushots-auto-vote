const mockRuntime = {
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
    isCli: jest.fn(() => false),
    isElectron: jest.fn(() => true),
    isPackaged: jest.fn(() => true),
};
const mockSea = { isSea: jest.fn(() => false) };
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

const path = require('node:path');
const {
    pickVisuallyVerified,
    selectVisualMatches,
    themePrompt,
    __resetForTests,
} = require('../../src/js/services/visionVerifier');

const hex = (seed) => seed.repeat(32).slice(0, 32);
const photo = (id) => ({ id: hex(id), member_id: hex('f') });
const BANISTERS = { id: 'c1', title: 'Banisters' };

const makeLogger = () => {
    const scoped = { info: jest.fn(), warning: jest.fn() };
    return { scoped, withCategory: jest.fn(() => scoped), challengeTag: jest.fn(() => '[Challenge c1: Banisters]') };
};

// Scores keyed by the photo id embedded in each CDN URL.
const scoreBy = (scores) =>
    mockClassifier.mockImplementation(async (url) => {
        const id = Object.keys(scores).find((key) => url.includes(`3_${hex(key)}`));
        return [{ score: scores[id] }];
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
});

test('a validated Banisters prompt rejects the real motorcycle and beach outliers', () => {
    // Measured on the user's live themed-search shortlist with bundled SigLIP.
    const scored = [
        { id: 'handrail', score: 0.0117948595 },
        { id: 'motorcycle', score: 0.00000001668 },
        { id: 'beach', score: 0.000004933 },
    ];
    expect(selectVisualMatches(scored, 3)).toEqual(['handrail']);
});

test('weak visual evidence stands down, and unvalidated themes keep tag ranking', () => {
    expect(
        selectVisualMatches(
            [
                { id: 'first', score: 0.0002 },
                { id: 'second', score: 0.0001 },
            ],
            1,
        ),
    ).toEqual([]);
    expect(themePrompt({ title: '  BANISTERS ' })).toBe('a photo of a banister or handrail');
    expect(themePrompt({ title: 'Best Meals' })).toBeNull();
    expect(themePrompt({ title: 'Smoke-Filled Scenes' })).toBeNull();
    expect(themePrompt({})).toBeNull();
    expect(themePrompt(undefined)).toBeNull();
});

describe('pickVisuallyVerified', () => {
    test('unvalidated themes and empty shortlists keep the tag pick without loading the model', async () => {
        const logger = makeLogger();
        expect(await pickVisuallyVerified({ title: 'Best Meals' }, ['a', 'b'], [], 1, logger)).toEqual(['a']);
        expect(await pickVisuallyVerified(BANISTERS, [], [], 1, logger)).toEqual([]);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('a candidate without a buildable photo URL keeps the tag pick', async () => {
        const ids = [hex('a'), 'not-an-md5'];
        const eligible = [photo('a'), { id: 'not-an-md5', member_id: hex('f') }];
        expect(await pickVisuallyVerified(BANISTERS, ids, eligible, 1, makeLogger())).toEqual([hex('a')]);
        expect(mockTransformers.pipeline).not.toHaveBeenCalled();
    });

    test('packaged Electron vetoes a weak tag pick and loads the model from resources once', async () => {
        scoreBy({ a: 0.00001, b: 0.02, c: 0.01, d: 0.0000001 });
        const ids = ['a', 'b', 'c', 'd'].map(hex);
        const eligible = ['a', 'b', 'c', 'd'].map(photo);
        const logger = makeLogger();

        expect(await pickVisuallyVerified(BANISTERS, ids, eligible, 2, logger)).toEqual([hex('b'), hex('c')]);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            'Visual check skipped weak matches for [Challenge c1: Banisters]',
            null,
        );
        expect(mockClassifier).toHaveBeenCalledWith(expect.stringContaining('/256x256/'), [
            'a photo of a banister or handrail',
        ]);
        expect(mockTransformers.env).toMatchObject({
            allowRemoteModels: false,
            allowLocalModels: true,
            localModelPath: `/app/resources${path.sep}`,
        });
        expect(mockTransformers.pipeline).toHaveBeenCalledWith('zero-shot-image-classification', 'vision-model', {
            dtype: 'q8',
            device: 'cpu',
        });

        await pickVisuallyVerified(BANISTERS, ids, eligible, 2, logger);
        expect(mockTransformers.pipeline).toHaveBeenCalledTimes(1);
    });

    test('an unchanged pick logs nothing', async () => {
        scoreBy({ a: 0.02, b: 0.01 });
        const logger = makeLogger();
        const result = await pickVisuallyVerified(BANISTERS, [hex('a'), hex('b')], [photo('a'), photo('b')], 1, logger);
        expect(result).toEqual([hex('a')]);
        expect(logger.scoped.info).not.toHaveBeenCalled();
    });

    test('an all-weak shortlist stands down with an empty pick', async () => {
        scoreBy({ a: 0.0001, b: 0.0002 });
        const logger = makeLogger();
        expect(
            await pickVisuallyVerified(BANISTERS, [hex('a'), hex('b')], [photo('a'), photo('b')], 1, logger),
        ).toEqual([]);
        expect(logger.scoped.info).toHaveBeenCalledWith(
            'Visual check found no strong match for [Challenge c1: Banisters]; standing down',
            null,
        );
    });

    test.each([[[]], [undefined], [[{ score: Number.NaN }]]])(
        'an unusable classifier result %p keeps the tag pick',
        async (output) => {
            mockClassifier.mockResolvedValue(output);
            expect(
                await pickVisuallyVerified(BANISTERS, [hex('a'), hex('b')], [photo('a'), photo('b')], 1, makeLogger()),
            ).toEqual([hex('a')]);
        },
    );

    test.each([
        [new Error('onnx missing'), 'onnx missing'],
        ['bare failure', 'bare failure'],
    ])('a model load failure (%p) keeps the tag pick and warns', async (failure, detail) => {
        mockTransformers.pipeline.mockRejectedValueOnce(failure);
        const logger = makeLogger();
        expect(await pickVisuallyVerified(BANISTERS, [hex('a')], [photo('a')], 1, logger)).toEqual([hex('a')]);
        expect(logger.scoped.warning).toHaveBeenCalledWith(
            `Visual check unavailable for [Challenge c1: Banisters]: ${detail}`,
            null,
        );
    });

    test.each([
        ['Capacitor', () => mockRuntime.isCapacitor.mockReturnValue(true)],
        ['the headless service', () => mockRuntime.isHeadlessService.mockReturnValue(true)],
    ])('%s runs single-threaded WASM from the WebView origin', async (_name, arrange) => {
        arrange();
        scoreBy({ a: 0.02 });
        await pickVisuallyVerified(BANISTERS, [hex('a')], [photo('a')], 1, makeLogger());
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
        scoreBy({ a: 0.02 });
        await pickVisuallyVerified(BANISTERS, [hex('a')], [photo('a')], 1, makeLogger());
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
        scoreBy({ a: 0.02 });
        await pickVisuallyVerified(BANISTERS, [hex('a')], [photo('a')], 1, makeLogger());
        expect(mockExtract).not.toHaveBeenCalled();
        expect(mockTransformers.env.localModelPath).toBe(path.join(__dirname, '..', '..', '.cache') + path.sep);
    });
});
