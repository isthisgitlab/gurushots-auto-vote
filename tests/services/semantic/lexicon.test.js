/**
 * Tests for the static word-vector lexicon backend.
 *
 * tests/setup.js mocks `fs`/`path` globally, so the cross-platform asset loader
 * (assets.js) can't read the real file here. We mock that loader to hand back
 * the real shipped lexicon JSON (read via requireActual) and exercise the
 * lexicon math against actual data. The platform loader itself is integration
 * code, exercised in real runs.
 *
 * The vectors are real pretrained GloVe embeddings (mean-centered and
 * cluster-retrofitted — see scripts/fetch-embeddings.js), so unlike the old
 * synthetic scheme, synonyms do NOT embed to identical vectors. The properties
 * under test are the ones the picker actually relies on: synonym pairs land
 * clearly above the semantic floor, unrelated pairs land clearly below it, and
 * the broad theme vocabulary (colors, events, animals, sports…) is present.
 */

const realFs = jest.requireActual('fs');
const realPath = jest.requireActual('path');
const mockLexicon = JSON.parse(
    realFs.readFileSync(realPath.join(__dirname, '..', '..', '..', 'src', 'assets', 'semantic-vectors.json'), 'utf8'),
);

jest.mock('../../../src/js/services/semantic/assets', () => ({
    loadLexiconAsset: async () => mockLexicon,
    ASSET_NAME: 'semantic-vectors.json',
    __resetForTests: () => {},
}));

const lexicon = require('../../../src/js/services/semantic/lexicon');
const { SEMANTIC_MATCH_FLOOR } = require('../../../src/js/services/photoPicker');

const FLOOR = SEMANTIC_MATCH_FLOOR / 100;

const sim = (a, b) => lexicon.cosine(lexicon.embed(a), lexicon.embed(b));

describe('semantic lexicon backend', () => {
    beforeEach(() => lexicon.__resetForTests());

    test('loads the lexicon asset', async () => {
        expect(await lexicon.isAvailable()).toBe(true);
    });

    test('synonyms across the substring-matcher blind spots score above the floor', async () => {
        await lexicon.init();
        // Each pair is a real gap: no shared substring, so photoPicker.matches()
        // scores 0 — but they mean the same thing, so the semantic tier must
        // place them above SEMANTIC_MATCH_FLOOR (i.e. "on theme").
        expect(sim(['feline'], ['cat'])).toBeGreaterThan(FLOOR);
        expect(sim(['canine'], ['dog'])).toBeGreaterThan(FLOOR);
        expect(sim(['automobile'], ['car'])).toBeGreaterThan(FLOOR);
        expect(sim(['avian'], ['bird'])).toBeGreaterThan(FLOOR);
        expect(sim(['blossom'], ['flower'])).toBeGreaterThan(FLOOR);
        expect(sim(['monochrome'], ['grayscale'])).toBeGreaterThan(FLOOR);
        // Head-final compounds — the exact case the prefix matcher documents as
        // its known cost, delegated to this tier ("sunflower" IS a "flower").
        expect(sim(['sunflower'], ['flower'])).toBeGreaterThan(FLOOR);
    });

    test('unrelated concepts score below the floor', async () => {
        await lexicon.init();
        expect(sim(['cat'], ['skyscraper'])).toBeLessThan(FLOOR);
        expect(sim(['pizza'], ['bicycle'])).toBeLessThan(FLOOR);
        expect(sim(['wedding'], ['tractor'])).toBeLessThan(FLOOR);
    });

    test('synonyms score far higher than unrelated concepts', async () => {
        await lexicon.init();
        const synonym = sim(['cat'], ['feline']);
        const unrelated = sim(['cat'], ['skyscraper']);
        expect(synonym - unrelated).toBeGreaterThan(0.4);
    });

    test('plural / inflected forms stem to the identical vector', async () => {
        await lexicon.init();
        // "cats" and "cat" share a stem, so they are literally the same lexicon
        // entry — cosine exactly 1 (within float noise).
        expect(sim(['cats'], ['cat'])).toBeGreaterThan(0.999);
        expect(sim(['puppies'], ['puppy'])).toBeGreaterThan(0.999);
    });

    test('the new theme coverage is in vocabulary', async () => {
        await lexicon.init();
        // One probe per expansion area: colors, events, wild animals, marine
        // life, sports, architecture, holidays, emotions, tech, fire.
        for (const word of [
            'red',
            'wedding',
            'lion',
            'whale',
            'soccer',
            'castle',
            'halloween',
            'love',
            'drone',
            'campfire',
        ]) {
            expect(lexicon.embed([word])).not.toBeNull();
        }
    });

    test('embed is deterministic', async () => {
        await lexicon.init();
        expect(Array.from(lexicon.embed(['cat', 'kitten']))).toEqual(Array.from(lexicon.embed(['cat', 'kitten'])));
    });

    test('out-of-vocabulary tokens and empty input degrade to null without throwing', async () => {
        await lexicon.init();
        expect(lexicon.embed(['zzqqxx', 'wibblewobble'])).toBeNull();
        expect(lexicon.embed([])).toBeNull();
        expect(lexicon.embed('not-an-array')).toBeNull();
    });

    test('cosine is safe with a null operand', () => {
        expect(lexicon.cosine(null, null)).toBe(0);
        expect(lexicon.cosine(null, new Float64Array(4))).toBe(0);
    });
});

describe('buildTable — v2 packed asset decode', () => {
    // A known 4-dim vector with negative components, quantized at scale 0.01.
    const DIMS = 4;
    const SCALE = 0.01;
    const INT8 = Int8Array.from([127, -127, 5, 0]);
    const packedOf = (int8) => Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength).toString('base64');
    // Buffer-free encoder for tests that run with global.Buffer removed.
    const packedViaCharCodes = (int8) => btoa(String.fromCharCode(...Array.from(int8, (b) => (b + 256) % 256)));
    const asset = (packed) => ({ version: 2, dims: DIMS, scale: SCALE, packed });

    test('round-trips values, including negative components', () => {
        const table = lexicon.buildTable(asset({ word: packedOf(INT8) }));
        expect(table).not.toBeNull();
        const vec = table.words.get('word');
        expect(Array.from(vec).map((x) => Number(x.toFixed(4)))).toEqual([1.27, -1.27, 0.05, 0]);
    });

    test('decodes identically through the atob fallback (no Buffer)', () => {
        // The Android WebView has no Buffer — the fallback must reinterpret
        // char codes > 127 as negative bytes. A sign bug here corrupts every
        // negative component silently, so pin byte-for-byte equality.
        const packed = { word: packedOf(INT8) };
        const viaBuffer = lexicon.buildTable(asset(packed));
        const originalBuffer = global.Buffer;
        try {
            delete global.Buffer;
            const viaAtob = lexicon.buildTable(asset(packed));
            expect(Array.from(viaAtob.words.get('word'))).toEqual(Array.from(viaBuffer.words.get('word')));
        } finally {
            global.Buffer = originalBuffer;
        }
    });

    test('skips malformed entries but keeps the valid ones', () => {
        const table = lexicon.buildTable(
            asset({
                ok: packedOf(INT8),
                wrongDims: packedOf(Int8Array.from([1, 2])),
                notAString: 42,
                empty: '',
            }),
        );
        expect(table.words.size).toBe(1);
        expect(table.words.has('ok')).toBe(true);
    });

    test('rejects non-v2 / structurally invalid assets', () => {
        expect(lexicon.buildTable(null)).toBeNull();
        expect(lexicon.buildTable({})).toBeNull();
        expect(lexicon.buildTable({ version: 1, dims: 4, scale: 1, words: {} })).toBeNull();
        expect(lexicon.buildTable({ version: 2, dims: NaN, scale: 1, packed: {} })).toBeNull();
        expect(lexicon.buildTable({ version: 2, dims: 4, scale: NaN, packed: {} })).toBeNull();
        expect(lexicon.buildTable({ version: 2, dims: 4, scale: 1, packed: {} })).toBeNull();
    });

    test('an entry that makes atob throw is skipped, not fatal (no-Buffer path)', () => {
        const originalBuffer = global.Buffer;
        try {
            delete global.Buffer;
            const table = lexicon.buildTable(asset({ ok: packedViaCharCodes(INT8), bad: '!!!not-base64!!!' }));
            expect(table.words.size).toBe(1);
            expect(table.words.has('ok')).toBe(true);
        } finally {
            global.Buffer = originalBuffer;
        }
    });
});
