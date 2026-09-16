/**
 * Tests for api/tags.js — the two reads that let auto-fill turn a challenge
 * term into a tag the member's library actually carries.
 */

const { getCurrentMemberProfile, searchTagAutocomplete, MIN_AUTOCOMPLETE_CHARS } = require('../../src/js/api/tags');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

describe('api/tags', () => {
    const token = 'tok-123';
    const { makePostRequest } = require('../../src/js/api/api-client');

    beforeEach(() => {
        makePostRequest.mockReset();
    });

    describe('getCurrentMemberProfile', () => {
        test('returns the id and user_name from the profile payload', async () => {
            makePostRequest.mockResolvedValue({
                profile: { id: 'c1d1f773', user_name: 'someguru', name: 'Display Name' },
                success: true,
            });
            await expect(getCurrentMemberProfile(token)).resolves.toEqual({ id: 'c1d1f773', userName: 'someguru' });
        });

        test('resolves null when the transport returned null', async () => {
            // makePostRequest never throws — it returns null — so this is the
            // shape every failure arrives in.
            makePostRequest.mockResolvedValue(null);
            await expect(getCurrentMemberProfile(token)).resolves.toBeNull();
        });

        test('resolves null when the payload carries no usable id', async () => {
            makePostRequest.mockResolvedValue({ profile: { user_name: 'someguru' }, success: true });
            await expect(getCurrentMemberProfile(token)).resolves.toBeNull();
        });

        test('a missing user_name is not fatal — the id is what lookups need', async () => {
            makePostRequest.mockResolvedValue({ profile: { id: 'c1d1f773' } });
            await expect(getCurrentMemberProfile(token)).resolves.toEqual({ id: 'c1d1f773', userName: '' });
        });

        test('requires a token', async () => {
            await expect(getCurrentMemberProfile('')).rejects.toThrow('tags: token is required');
        });
    });

    describe('searchTagAutocomplete', () => {
        test('sends the term and member id, and returns the matching tags', async () => {
            makePostRequest.mockResolvedValue({ items: ['staircase'], success: true });
            await expect(searchTagAutocomplete(token, 'stair', 'c1d1f773')).resolves.toEqual(['staircase']);
            const [, , body] = makePostRequest.mock.calls[0];
            expect(body).toBe('search=stair&member_id=c1d1f773');
        });

        test('skips the round-trip below the server-side minimum', async () => {
            // The live endpoint answers [] for anything shorter, so a request
            // here would be a guaranteed waste.
            expect(MIN_AUTOCOMPLETE_CHARS).toBe(3);
            await expect(searchTagAutocomplete(token, 'st', 'c1d1f773')).resolves.toEqual([]);
            expect(makePostRequest).not.toHaveBeenCalled();
        });

        test('skips the round-trip without a member id', async () => {
            await expect(searchTagAutocomplete(token, 'stair', '')).resolves.toEqual([]);
            expect(makePostRequest).not.toHaveBeenCalled();
        });

        test('url-encodes a multi-word term rather than injecting form fields', async () => {
            makePostRequest.mockResolvedValue({ items: [] });
            await searchTagAutocomplete(token, 'flower b&x=1', 'c1d1f773');
            const [, , body] = makePostRequest.mock.calls[0];
            expect(body).toBe('search=flower%20b%26x%3D1&member_id=c1d1f773');
        });

        test('returns [] on a null or malformed payload', async () => {
            makePostRequest.mockResolvedValue(null);
            await expect(searchTagAutocomplete(token, 'stair', 'm')).resolves.toEqual([]);
            makePostRequest.mockResolvedValue({ success: false, error_code: 1105 });
            await expect(searchTagAutocomplete(token, 'stair', 'm')).resolves.toEqual([]);
        });

        test('filters non-string entries and normalises the rest', async () => {
            // The payload is untrusted; a malformed entry must never reach the
            // photo-search query string.
            makePostRequest.mockResolvedValue({ items: ['  Staircase  ', 42, null, '', 'Flower Bouquet'] });
            await expect(searchTagAutocomplete(token, 'stair', 'm')).resolves.toEqual(['staircase', 'flower bouquet']);
        });
    });
});
