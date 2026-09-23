/**
 * Tests for scripts/validate-lexicon.js main() — the statistical gate, driven
 * by a tiny fake lexicon (hand-placed 2-D vectors, cosine = dot product) and a
 * fixture eval config, so every gate outcome is reachable without loading the
 * committed semantic-vectors.json asset. process.exit is stubbed to throw so a
 * fatal path stops exactly where the real process would.
 */

const lexicon = require('../../src/js/services/semantic/lexicon');
const { main } = require('../../scripts/validate-lexicon');

// Fake lexicon: embed() mean-pools the known words (null when none are known),
// cosine() is a plain dot product. 'nan' embeds to a non-finite vector so the
// Number.isFinite guard is exercised.
const VECTORS = {
    farm: [1, 0],
    barn: [0.9, 0.1],
    cow: [0.95, 0.05],
    nan: [NaN, NaN],
    sheep: [0.9, 0.2],
    wave: [0, 1],
    box: [0.5, 0.5],
    toy: [0.4, 0.6],
};
const fakeLex = {
    init: async () => true,
    embed: (words) => {
        const known = words.filter((w) => VECTORS[w]);
        if (!known.length) return null;
        const out = [0, 0];
        for (const w of known) for (let i = 0; i < 2; i++) out[i] += VECTORS[w][i] / known.length;
        return out;
    },
    cosine: (a, b) => a[0] * b[0] + a[1] * b[1],
};

const CONCEPTS = [
    { id: 'farm', parent: 'rural', words: ['farm', 'barn', 'cow', 'nan'] },
    { id: 'livestock', parent: 'rural', words: ['sheep'] },
    { id: 'ghost', parent: 'rural', words: ['zzz'] }, // nothing in vocabulary
    { id: 'barnyard', parent: 'rural', words: ['barn', 'cow', 'zzz'] }, // spare word out of vocabulary
    { id: 'sea', parent: 'ocean', words: ['wave'] },
    { id: 'box', parent: 'object', words: ['box'] },
    { id: 'toy', parent: 'object', words: ['toy'] },
    { id: 'wordless', parent: 'rural' }, // passes ref checks, dropped by main's filter
    { id: 'blank', parent: 'rural', words: [] },
    { id: 'orphan', words: ['farm'] },
];
const BASE_CONFIG = {
    organizationalParents: ['object'],
    unrelatedParents: [['rural', 'ocean']],
    concepts: CONCEPTS,
};

describe('validate-lexicon main', () => {
    let exitSpy;
    let logSpy;
    let errorSpy;

    const run = (config, matchFloor = 50) => main({ lex: fakeLex, config, matchFloor });
    const logs = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const errors = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('defaults to the real lexicon, config and floor (stopped at an unavailable asset)', async () => {
        const initSpy = jest.spyOn(lexicon, 'init').mockResolvedValue(false);
        await expect(main()).rejects.toThrow('exit 1');
        expect(initSpy).toHaveBeenCalled();
        expect(errors()).toContain('lexicon asset unavailable');
    });

    test('fails on an inconsistent eval config', async () => {
        await expect(run({ ...BASE_CONFIG, organizationalParents: ['objct'] })).rejects.toThrow('exit 1');
        expect(errors()).toContain('eval config is inconsistent');
        expect(errors()).toContain('objct');
    });

    test('fails when the config yields no related pairs', async () => {
        await expect(run({})).rejects.toThrow('exit 1');
        expect(errors()).toContain('n_related=0, n_unrelated=0');
    });

    test('fails when the config yields no unrelated pairs', async () => {
        await expect(run({ concepts: CONCEPTS })).rejects.toThrow('exit 1');
        expect(errors()).toMatch(/n_related=\d+, n_unrelated=0/);
    });

    test('passes when the floor sits in the gap, reporting near-misses on both sides of it', async () => {
        await run({
            ...BASE_CONFIG,
            nearMissPairs: [
                ['farm', 'livestock'], // above the floor
                ['farm', 'sea'], // below the floor
                ['ghost', 'farm'], // challenge not in vocabulary
                ['farm', 'ghost'], // photo not in vocabulary
            ],
        });
        expect(exitSpy).not.toHaveBeenCalled();
        const out = logs();
        expect(out).toContain('near-miss pairs (2; reported, not gated)');
        expect(out).toContain('    ⚠️ farm<->livestock = 0.865');
        expect(out).toContain('    farm<->sea = 0.050');
        expect(out).toContain('1/2 near-miss pair(s) score above the floor');
        expect(out).toContain('✅ Floor sits in the gap');
    });

    test('near-misses all below the floor print no warning', async () => {
        await run({ ...BASE_CONFIG, nearMissPairs: [['farm', 'sea']] });
        expect(logs()).toContain('near-miss pairs (1;');
        expect(logs()).not.toContain('score above the floor');
    });

    test('no scorable near-misses prints no near-miss block', async () => {
        await run({ ...BASE_CONFIG, nearMissPairs: [['ghost', 'farm']] });
        expect(logs()).not.toContain('near-miss pairs');
        expect(logs()).toContain('✅');
    });

    test('fails on a near-miss id that exists but has no usable words', async () => {
        await expect(run({ ...BASE_CONFIG, nearMissPairs: [['farm', 'wordless']] })).rejects.toThrow('exit 1');
        expect(errors()).toContain('nearMissPairs references unknown concept id: farm / wordless');
    });

    test('fails when an unknown first near-miss id slips past the ref check', async () => {
        await expect(run({ ...BASE_CONFIG, nearMissPairs: [['blank', 'farm']] })).rejects.toThrow('exit 1');
        expect(errors()).toContain('blank / farm');
    });

    test('fails when unrelated noise scores above the floor', async () => {
        await expect(run(BASE_CONFIG, 0)).rejects.toThrow('exit 1');
        expect(errors()).toContain('noise would be scored as a theme match');
        expect(errors()).not.toContain('genuinely on-theme photos would be discarded');
    });

    test('fails when the floor discards genuinely related photos', async () => {
        await expect(run(BASE_CONFIG, 100)).rejects.toThrow('exit 1');
        expect(errors()).toContain('genuinely on-theme photos would be discarded');
        expect(errors()).not.toContain('noise would be scored');
    });
});
