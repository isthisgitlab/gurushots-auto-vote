/**
 * Tests for the lexicon build pipeline's pure functions — the logic that
 * decides what ships in the semantic vector asset, exercised against small
 * fixtures (the network download and zip streaming stay manual, un-CI'd).
 *
 * Two fatal gates matter most and were previously asserted against nothing:
 *   - a word claimed by two clusters (authoring mistake -> collision)
 *   - an authored word missing from the intermediate (stale intermediate)
 * Both must be REPORTED by the pure layer so the script entry points can fail
 * the build; a silent pass here means degraded vectors ship undetected.
 */

const { buildAsset } = require('../../scripts/build-lexicon');
const {
    collectAuthoredWords,
    parseGloveLine,
    normalize,
    retrofit,
    assignStems,
    quantizePack,
    GENERIC_TOKEN_RE,
} = require('../../scripts/fetch-embeddings');

const vec = (...xs) => Float64Array.from(xs);

describe('build-lexicon buildAsset', () => {
    const intermediate = {
        dims: 4,
        scale: 0.01,
        meanCentered: true,
        source: { url: 'https://example.test/glove.zip', entrySha256: 'abc' },
        // Stem keys for: cat, kitten, dog (stemmed forms of the fixture words)
        packed: { cat: 'AAAA', kitten: 'AAAA', dog: 'AAAA' },
    };

    test('assembles a v2 asset carrying the intermediate through verbatim', () => {
        const concepts = { concepts: [{ id: 'cat', parent: 'pet', words: ['cat', 'kitten'] }] };
        const { output, missing, collisions } = buildAsset(intermediate, concepts);
        expect(missing).toEqual([]);
        expect(collisions).toEqual([]);
        expect(output.version).toBe(2);
        expect(output.dims).toBe(4);
        expect(output.scale).toBe(0.01);
        expect(output.source).toBe(intermediate.source);
        expect(output.packed).toBe(intermediate.packed);
    });

    test('reports an authored word whose stem is missing from the intermediate', () => {
        const concepts = { concepts: [{ id: 'bird', parent: 'bird', words: ['bird'] }] };
        const { missing } = buildAsset(intermediate, concepts);
        expect(missing).toHaveLength(1);
        expect(missing[0]).toContain('bird');
    });

    test('reports a missing extraWords entry too', () => {
        const concepts = { concepts: [], extraWords: ['sofa'] };
        const { missing } = buildAsset(intermediate, concepts);
        expect(missing).toHaveLength(1);
        expect(missing[0]).toContain('extraWords');
    });

    test('reports a stem claimed by two different clusters', () => {
        const concepts = {
            concepts: [
                { id: 'cat', parent: 'pet', words: ['cat'] },
                { id: 'feline', parent: 'wild', words: ['cats'] }, // stems to "cat" as well
            ],
        };
        const { collisions } = buildAsset(intermediate, concepts);
        expect(collisions).toHaveLength(1);
        expect(collisions[0]).toContain('cat');
    });

    test('the same word twice in ONE cluster is not a collision', () => {
        const concepts = { concepts: [{ id: 'cat', parent: 'pet', words: ['cat', 'cats'] }] };
        expect(buildAsset(intermediate, concepts).collisions).toEqual([]);
    });
});

describe('fetch-embeddings pure pipeline', () => {
    test('collectAuthoredWords maps surfaces to owners and flags cross-cluster stem collisions', () => {
        const { bySurface, collisions } = collectAuthoredWords({
            concepts: [
                { id: 'cat', parent: 'pet', words: ['Cat', 'kitten'] },
                { id: 'sky', parent: 'sky', words: ['skies'] }, // "skies" stems to "ski"
                { id: 'skiing', parent: 'wintersport', words: ['ski'] },
            ],
            extraWords: ['sofa'],
        });
        expect(bySurface.get('cat')).toBe('cat');
        expect(bySurface.get('sofa')).toBe('extraWords');
        expect(collisions).toHaveLength(1);
        expect(collisions[0]).toContain('ski');
    });

    test('parseGloveLine parses a valid line and rejects malformed ones', () => {
        expect(parseGloveLine('cat 0.5 -0.25', 2)).toEqual({ token: 'cat', vec: vec(0.5, -0.25) });
        expect(parseGloveLine('cat 0.5', 2)).toBeNull(); // wrong dims
        expect(parseGloveLine('cat 0.5 abc', 2)).toBeNull(); // non-numeric
        expect(parseGloveLine('', 2)).toBeNull();
    });

    test('GENERIC_TOKEN_RE admits plain lowercase words only', () => {
        expect(GENERIC_TOKEN_RE.test('cat')).toBe(true);
        expect(GENERIC_TOKEN_RE.test('a')).toBe(false); // too short
        expect(GENERIC_TOKEN_RE.test("o'clock")).toBe(false);
        expect(GENERIC_TOKEN_RE.test('café')).toBe(false);
        expect(GENERIC_TOKEN_RE.test('x'.repeat(21))).toBe(false); // too long
    });

    test('normalize produces a unit vector', () => {
        const v = vec(3, 4);
        normalize(v);
        expect(v[0]).toBeCloseTo(0.6);
        expect(v[1]).toBeCloseTo(0.8);
    });

    test('retrofit pulls cluster members toward each other and leaves others alone', () => {
        const a = vec(1, 0);
        const b = vec(0, 1);
        const lone = vec(-1, 0);
        const extra = vec(0, -1);
        const rows = [
            { token: 'cat', vec: a, isAuthored: true },
            { token: 'kitten', vec: b, isAuthored: true },
            { token: 'cactus', vec: lone, isAuthored: true },
            { token: 'sofa', vec: extra, isAuthored: true },
            { token: 'the', vec: vec(0.5, 0.5), isAuthored: false },
        ];
        const authored = new Map([
            ['cat', 'cat'],
            ['kitten', 'cat'],
            ['cactus', 'cactus'],
            ['sofa', 'extraWords'],
        ]);
        const count = retrofit(rows, authored, 0.5);
        expect(count).toBe(2); // only the two-member cat cluster moved
        const cosine = (x, y) => x[0] * y[0] + x[1] * y[1];
        expect(cosine(a, b)).toBeGreaterThan(0.5); // was 0 before the blend
        expect(Array.from(lone)).toEqual([-1, 0]); // single-word cluster untouched
        expect(Array.from(extra)).toEqual([0, -1]); // extraWords untouched
        expect(retrofit(rows, authored, 0)).toBe(0); // beta 0 is a no-op
    });

    test('assignStems: authored words beat more-frequent generic tokens on the same stem', () => {
        const rows = [
            // Generic "boxing" is FIRST (more frequent) but the authored word
            // must still own the shared stem.
            { token: 'boxing', vec: vec(1, 0), isAuthored: false }, // stems to "box"
            { token: 'box', vec: vec(0, 1), isAuthored: true },
        ];
        const { stems } = assignStems(rows, 0.4);
        expect(stems.get('box').token).toBe('box');
        expect(stems.get('box').isAuthored).toBe(true);
    });

    test('assignStems: generic-vs-generic keeps the more frequent word and counts disagreeing merges as bad', () => {
        const rows = [
            { token: 'day', vec: vec(1, 0), isAuthored: false },
            { token: 'days', vec: vec(1, 0), isAuthored: false }, // same lemma, cosine 1 — benign
            { token: 'dayed', vec: vec(-1, 0), isAuthored: false }, // fake word, opposite vector — bad merge
        ];
        const { stems, merges, badMerges, badSamples } = assignStems(rows, 0.4);
        expect(stems.get('day').token).toBe('day'); // first (most frequent) wins
        expect(merges).toBe(2);
        expect(badMerges).toBe(1);
        expect(badSamples[0]).toContain('dayed');
    });

    test('quantizePack round-trips through the runtime signed-byte decode', () => {
        const stems = new Map([
            ['pos', { vec: vec(1, 0.5) }],
            ['neg', { vec: vec(-1, -0.25) }],
        ]);
        const { scale, packed } = quantizePack(stems, 2);
        expect(scale).toBeCloseTo(1 / 127);
        const decode = (b64) => {
            const buf = Buffer.from(b64, 'base64');
            return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
        };
        expect(Array.from(decode(packed.pos))).toEqual([127, 64]);
        expect(Array.from(decode(packed.neg))).toEqual([-127, -32]);
    });
});
