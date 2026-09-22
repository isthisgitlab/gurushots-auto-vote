/**
 * lexicon.js against a tiny synthetic table: concurrent init() sharing one
 * load, and a zero vector that must not divide by zero when normalised.
 */

const toB64 = (ints) => Buffer.from(Int8Array.from(ints).buffer).toString('base64');
const mockAsset = {
    version: 2,
    dims: 2,
    scale: 1,
    packed: { zero: toB64([0, 0]), cat: toB64([3, 4]) },
};
const mockLoad = jest.fn(async () => mockAsset);

jest.mock('../../../src/js/services/semantic/assets', () => ({
    loadLexiconAsset: (...args) => mockLoad(...args),
    ASSET_NAME: 'semantic-vectors.json',
    __resetForTests: () => {},
}));

const lexicon = require('../../../src/js/services/semantic/lexicon');

beforeEach(() => {
    lexicon.__resetForTests();
    mockLoad.mockClear();
});

test('concurrent init() calls share one asset load', async () => {
    const [a, b] = await Promise.all([lexicon.init(), lexicon.init()]);
    expect(a).toBe(b);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    // Once loaded, a third call resolves from the table without loading again.
    await expect(lexicon.init()).resolves.toBe(a);
    expect(mockLoad).toHaveBeenCalledTimes(1);
});

test('an all-zero vector embeds to zeros instead of NaN', async () => {
    await lexicon.init();
    expect(Array.from(lexicon.embed(['zero']))).toEqual([0, 0]);
});

test('a non-zero vector is normalised to unit length', async () => {
    await lexicon.init();
    const [x, y] = lexicon.embed(['cat']);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.8);
});
