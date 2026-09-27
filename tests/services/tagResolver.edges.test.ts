/**
 * tagResolver.ts — the semantic-validation guards, driven through a stubbed
 * lexicon so each "no signal" exit (no challenge vector, empty tag, tag out of
 * vocabulary, non-finite cosine) is exercised deterministically. The real
 * shipped vectors are covered by tagResolver.test.ts.
 */

jest.mock('../../src/js/services/semantic/lexicon', () => ({
    isAvailable: jest.fn(async () => true),
    embed: jest.fn(() => new Float64Array([1, 0])),
    cosine: jest.fn(() => 0.99),
    // No opinion: title-subject ordering stays positional under this stub.
    concreteness: jest.fn(() => null),
}));

import lexiconModule = require('../../src/js/services/semantic/lexicon');
const lexicon = jest.mocked(lexiconModule);
import type * as tagResolverModule from '../../src/js/services/tagResolver';
import { invalid } from '../helpers/invalid';
const { resolveTermsToTags }: typeof tagResolverModule = require('../../src/js/services/tagResolver');

const challenge = { id: 1, title: 'Stairs', welcome_message: '' };
const deps = (tags: string[]) => ({
    token: 'tok',
    memberId: 'm',
    searchTagAutocomplete: jest.fn(async () => tags),
});

beforeEach(() => {
    lexicon.isAvailable.mockResolvedValue(true);
    lexicon.embed.mockImplementation(() => new Float64Array([1, 0]));
    lexicon.cosine.mockReturnValue(0.99);
});

test('an on-theme non-lexical tag is accepted when the lexicon scores it above the floor', async () => {
    await expect(resolveTermsToTags(['stair'], challenge, deps(['banister']))).resolves.toEqual(['banister']);
});

test('lexicon unavailable → no challenge vector → only lexical matches survive', async () => {
    lexicon.isAvailable.mockResolvedValue(false);
    await expect(resolveTermsToTags(['stair'], challenge, deps(['banister', 'stairs']))).resolves.toEqual(['stairs']);
    expect(lexicon.cosine).not.toHaveBeenCalled();
});

test('a tag with no tokens is not scored', async () => {
    await expect(resolveTermsToTags(['stair'], challenge, deps(['!!!']))).resolves.toEqual([]);
    expect(lexicon.cosine).not.toHaveBeenCalled();
});

test('a tag out of vocabulary (no embedding) is rejected', async () => {
    // First embed call is the challenge theme; the tag's own embedding misses.
    lexicon.embed.mockReturnValueOnce(new Float64Array([1, 0])).mockReturnValueOnce(null);
    await expect(resolveTermsToTags(['stair'], challenge, deps(['banister']))).resolves.toEqual([]);
    expect(lexicon.cosine).not.toHaveBeenCalled();
});

test('a non-finite cosine is "no signal", not a match', async () => {
    lexicon.cosine.mockReturnValue(Number.NaN);
    await expect(resolveTermsToTags(['stair'], challenge, deps(['banister']))).resolves.toEqual([]);
});

test('missing deps object → []', async () => {
    await expect(resolveTermsToTags(['stair'], challenge, invalid(undefined))).resolves.toEqual([]);
});

test('only too-short terms → [] without a lookup', async () => {
    const d = deps(['anything']);
    await expect(resolveTermsToTags(invalid(['ab', 7, null]), challenge, d)).resolves.toEqual([]);
    expect(d.searchTagAutocomplete).not.toHaveBeenCalled();
});
