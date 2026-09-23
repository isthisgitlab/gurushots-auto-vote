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

describe('concreteness', () => {
    afterEach(() => {
        delete mockAsset.concreteAxis;
    });

    test('is null before the table loads', () => {
        expect(lexicon.concreteness('cat')).toBeNull();
    });

    test('projects a word onto the shipped axis', async () => {
        mockAsset.concreteAxis = [1, 0];
        await lexicon.init();
        expect(lexicon.concreteness('cat')).toBeCloseTo(0.6);
        // Out of vocabulary: no opinion, which is not the same as 0.
        expect(lexicon.concreteness('dog')).toBeNull();
    });

    test.each([
        ['no axis', undefined],
        ['an axis of the wrong length', [1, 0, 0]],
        ['a non-finite axis', [1, NaN]],
        ['a non-array axis', { 0: 1, 1: 0 }],
    ])('is null for every word when the asset carries %s', async (_label, axis) => {
        mockAsset.concreteAxis = axis;
        await lexicon.init();
        expect(lexicon.embed(['cat'])).not.toBeNull();
        expect(lexicon.concreteness('cat')).toBeNull();
    });
});

test('embedIn pools against an explicit table and is null without one', async () => {
    const table = await lexicon.init();
    expect(Array.from(lexicon.embedIn(table, ['cat']))).toEqual(Array.from(lexicon.embed(['cat'])));
    expect(lexicon.embedIn(null, ['cat'])).toBeNull();
});
