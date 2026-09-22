/**
 * Edge-case coverage for photoPicker helpers: ignore-word normalisation
 * (Set vs array vs junk), negations whose subject tokenises to nothing,
 * label-group truncation at the per-photo stem ceiling, empty precomputed
 * stems, and malformed semantic-score entries.
 */

const {
    tokenise,
    parseNegation,
    labelStemGroups,
    scorePhoto,
    buildScoredCandidates,
} = require('../../src/js/services/photoPicker');

const allowed = (id, labels) => ({ id, labels, upload_date: 1000, permission: { allowed: true, message: null } });

describe('tokenise ignoreWords normalisation', () => {
    test('a non-empty Set is used as-is', () => {
        expect(tokenise('forest river', { ignoreWords: new Set(['river']) })).toEqual(tokenise('forest'));
    });

    test('an empty Set ignores nothing', () => {
        expect(tokenise('forest river', { ignoreWords: new Set() })).toEqual(tokenise('forest river'));
    });

    test('array entries are trimmed and lower-cased; non-strings and blanks are skipped', () => {
        expect(tokenise('forest river', { ignoreWords: [42, '   ', ' RIVER '] })).toEqual(tokenise('forest'));
    });

    test('an array holding only junk ignores nothing', () => {
        expect(tokenise('forest river', { ignoreWords: [null, ''] })).toEqual(tokenise('forest river'));
    });
});

describe('parseNegation when the negated subject tokenises to nothing', () => {
    test('a lead negation with no usable word is not a negation', () => {
        expect(parseNegation('No a')).toEqual({ positiveTitle: 'No a', stems: [], active: false });
    });

    test('an ignored subject leaves the lead-negated segment in place', () => {
        const result = parseNegation('No People', ['people']);
        expect(result.active).toBe(false);
        expect(result.positiveTitle).toBe('No People');
    });

    test('an ignored "-free" subject keeps the compound in the positive title', () => {
        const result = parseNegation('Sugar-free Treats', ['sugar']);
        expect(result.active).toBe(false);
        expect(result.positiveTitle).toBe('Sugar-free Treats');
    });

    test('mixing a real "-free" subject with an ignored one only strips the real one', () => {
        const result = parseNegation('Sugar-free Gluten-free', ['sugar']);
        expect(result.active).toBe(true);
        expect(result.stems).toEqual(tokenise('gluten'));
        expect(result.positiveTitle).toContain('Sugar-free');
        expect(result.positiveTitle).not.toContain('Gluten-free');
    });
});

describe('labelStemGroups', () => {
    test('skips non-string labels and labels that tokenise to nothing', () => {
        const groups = labelStemGroups({ labels: [null, { x: 1 }, '!!!', 'Cat', 'cat', 'Big Dog'] });
        expect(groups).toEqual([
            tokenise('cat', { keepStopwords: true }),
            tokenise('big dog', { keepStopwords: true }),
        ]);
    });

    test('numeric labels are stringified before tokenising', () => {
        expect(labelStemGroups({ labels: [2024] })).toEqual([]); // pure digits → no words
    });

    test('truncates the boundary label at the 64-stem ceiling and stops there', () => {
        // Letters-only nonsense words: no stemming suffixes, no trailing digits.
        const letters = 'bcdfghjklmnpqrstvwxz';
        const word = (i) => `zq${letters[Math.floor(i / letters.length)]}${letters[i % letters.length]}`;
        const labels = [];
        for (let l = 0; l < 6; l++) {
            labels.push(Array.from({ length: 12 }, (_, w) => word(l * 12 + w)).join(' '));
        }
        labels.push('elephant'); // after the ceiling — must never be read
        const groups = labelStemGroups({ labels });
        expect(groups).toHaveLength(6);
        expect(groups[5]).toHaveLength(4); // 5 * 12 = 60, room for 4 more
        expect(groups.flat()).toHaveLength(64);
        expect(groups.flat()).not.toContain(tokenise('elephant')[0]);
    });
});

describe('scorePhoto', () => {
    test('skips empty precomputed stems instead of matching them', () => {
        const [cat] = tokenise('cat');
        expect(scorePhoto({ labels: [] }, [cat], ['', cat])).toBe(1);
    });
});

describe('buildScoredCandidates semantic tiers', () => {
    const challenge = { title: 'Pink In Nature', url: '', welcome_message: '' };

    test('works without an opts argument (no semantic map → zero tiers)', () => {
        const [scored] = buildScoredCandidates(challenge, [allowed('a', ['Random'])]);
        expect(scored.semantic).toBe(0);
        expect(scored.semanticSupport).toBe(0);
    });

    test('a non-finite score entry is treated as no semantic signal', () => {
        const semanticScores = new Map([
            ['a', { score: Number.NaN, support: 3 }],
            ['b', { support: 2 }],
            ['c', 0.5],
        ]);
        const scored = buildScoredCandidates(
            challenge,
            [allowed('a', ['Random']), allowed('b', ['Random']), allowed('c', ['Random'])],
            { semanticScores },
        );
        const byId = Object.fromEntries(scored.map((s) => [s.id, s]));
        expect(byId.a.semantic).toBe(0);
        expect(byId.a.semanticSupport).toBe(0);
        expect(byId.b.semantic).toBe(0);
        expect(byId.c.semantic).toBeGreaterThan(0);
    });
});
