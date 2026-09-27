/**
 * Defensive paths of getSemanticScores, driven through a stubbed lexicon so
 * each failure shape is exact: a theme with no vector, id-less photos, a
 * non-finite similarity, the bounded embedding cache, and a thrown lexicon.
 */

jest.mock('../../../src/js/services/semantic/lexicon', () => ({
    isAvailable: jest.fn(async () => true),
    embed: jest.fn(() => [1, 0]),
    cosine: jest.fn(() => 0.9),
    // No opinion: title-subject ordering stays positional under this stub.
    concreteness: jest.fn(() => null),
}));

import lexiconModule = require('../../../src/js/services/semantic/lexicon');
const lexicon = jest.mocked(lexiconModule);
import type * as semanticModule from '../../../src/js/services/semantic';
import type * as photoPickerModule from '../../../src/js/services/photoPicker';
import type { PickerPhoto } from '../../../src/js/types/photoPicker';
import { invalid } from '../../helpers/invalid';
const { getSemanticScores, __resetForTests }: typeof semanticModule = require('../../../src/js/services/semantic');
const { buildThemeKeywords }: typeof photoPickerModule = require('../../../src/js/services/photoPicker');

const challenge = { title: 'Feline Friends', url: 'feline-friends' };
const photo = (id: string, labels = ['Cat']): PickerPhoto => ({ id, labels });
const themeKey = JSON.stringify([...buildThemeKeywords(challenge)].sort());
const themeEmbeds = () => lexicon.embed.mock.calls.filter(([t]) => JSON.stringify([...t].sort()) === themeKey).length;

beforeEach(() => {
    __resetForTests();
    lexicon.isAvailable.mockResolvedValue(true);
    lexicon.embed.mockImplementation(() => invalid([1, 0]));
    lexicon.cosine.mockImplementation(() => 0.9);
});

test('returns null when the theme itself has no vector', async () => {
    lexicon.embed.mockReturnValue(null);
    await expect(getSemanticScores(challenge, [photo('p1')])).resolves.toBeNull();
    expect(lexicon.cosine).not.toHaveBeenCalled();
});

test('skips null and id-less photos but scores the rest', async () => {
    const scores = await getSemanticScores(challenge, [
        invalid(null),
        photo(invalid(undefined)),
        photo(invalid(null)),
        photo('p1'),
    ]);
    expect([...scores!.keys()]).toEqual(['p1']);
    expect(scores!.get('p1')).toEqual({ score: 0.9, support: 1 });
});

test('a non-finite similarity is ignored rather than ranked', async () => {
    lexicon.cosine.mockReturnValueOnce(Number.NaN).mockReturnValueOnce(0.4);
    const scores = await getSemanticScores(challenge, [photo('nan'), photo('ok')]);
    expect(scores!.has('nan')).toBe(false);
    expect(scores!.get('ok')!.score).toBeCloseTo(0.4);
});

test('a photo whose only similarity is non-finite yields null overall', async () => {
    lexicon.cosine.mockReturnValue(Number.NaN);
    await expect(getSemanticScores(challenge, [photo('p1')])).resolves.toBeNull();
});

test('any throw inside the scorer degrades to null', async () => {
    lexicon.isAvailable.mockRejectedValue(new Error('asset exploded'));
    await expect(getSemanticScores(challenge, [photo('p1')])).resolves.toBeNull();
});

test('the embedding cache is bounded: overflowing it evicts the theme vector', async () => {
    // Warm run: the theme is embedded once, then served from the cache.
    await getSemanticScores(challenge, [photo('a')]);
    await getSemanticScores(challenge, [photo('a')]);
    expect(themeEmbeds()).toBe(1);

    // 4001 distinct letter-only labels (trailing digits are stripped by tokenise).
    const letters = 'bcfhjkmnpqrtvwxz';
    const word = (i: number) =>
        `z${letters[Math.floor(i / 256) % 16]}${letters[Math.floor(i / 16) % 16]}${letters[i % 16]}`;
    const many = Array.from({ length: 4001 }, (_, i) => photo(`p${i}`, [word(i)]));
    await getSemanticScores(challenge, many);
    await getSemanticScores(challenge, [photo('a')]);
    expect(themeEmbeds()).toBe(2);
});
