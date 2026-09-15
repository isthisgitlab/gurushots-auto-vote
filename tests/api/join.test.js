/**
 * Tests for api/join.js — getMemberChallenges, coinsUnlock, getBankroll.
 * Focus: form-body encoding of dynamic values, return shapes, and bankroll
 * normalization (incl. the null-on-failure contract callers rely on).
 */

const { getMemberChallenges, coinsUnlock, getBankroll } = require('../../src/js/api/join');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

const { makePostRequest } = require('../../src/js/api/api-client');
const token = 'tok-123';

beforeEach(() => jest.clearAllMocks());

describe('getMemberChallenges', () => {
    test('posts filter body and returns items', async () => {
        makePostRequest.mockResolvedValueOnce({ items: [{ id: 1 }, { id: 2 }] });
        const items = await getMemberChallenges(token, 'open');
        const [url, headers, body] = makePostRequest.mock.calls[0];
        expect(url).toBe('https://api.gurushots.com/rest/get_member_challenges');
        expect(headers).toEqual(expect.objectContaining({ 'x-env': 'WEB', 'x-token': token }));
        expect(body).toBe('filter=open');
        expect(items).toHaveLength(2);
    });

    test('encodes the filter value (no form-field injection)', async () => {
        makePostRequest.mockResolvedValueOnce({ items: [] });
        await getMemberChallenges(token, 'a&b=c');
        expect(makePostRequest.mock.calls[0][2]).toBe('filter=a%26b%3Dc');
    });

    test('returns [] on null / malformed payload', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getMemberChallenges(token)).toEqual([]);
        makePostRequest.mockResolvedValueOnce({ nope: true });
        expect(await getMemberChallenges(token)).toEqual([]);
    });
});

describe('coinsUnlock', () => {
    test('posts encoded challenge_id + usage and maps success', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        const res = await coinsUnlock('13 39', token);
        expect(makePostRequest.mock.calls[0][2]).toBe('challenge_id=13%2039&usage=JOIN_CHALLENGE');
        expect(res).toEqual({ ok: true, raw: { success: true } });
    });

    test('ok:false on success:false and on null', async () => {
        makePostRequest.mockResolvedValueOnce({ success: false });
        expect((await coinsUnlock(1, token)).ok).toBe(false);
        makePostRequest.mockResolvedValueOnce(null);
        expect(await coinsUnlock(1, token)).toEqual({ ok: false, raw: null });
    });
});

describe('getBankroll', () => {
    test('normalizes the currency array to a flat balance', async () => {
        makePostRequest.mockResolvedValueOnce({
            success: true,
            bankroll: {
                challenges: [
                    { type: 'KEYS', amount: 8 },
                    { type: 'SWAPS', amount: 41 },
                    { type: 'FILLS', amount: 818 },
                    { type: 'COINS', amount: 17540 },
                    { type: 'UNKNOWN', amount: 5 },
                ],
            },
        });
        expect(await getBankroll(token)).toEqual({ keys: 8, swaps: 41, fills: 818, coins: 17540 });
    });

    test('posts an empty body', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true, bankroll: { challenges: [] } });
        await getBankroll(token);
        expect(makePostRequest.mock.calls[0][2]).toBe('');
    });

    test('returns null (not zeros) on failure or malformed payload', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getBankroll(token)).toBeNull();
        makePostRequest.mockResolvedValueOnce({ success: false });
        expect(await getBankroll(token)).toBeNull();
        makePostRequest.mockResolvedValueOnce({ success: true, bankroll: {} });
        expect(await getBankroll(token)).toBeNull();
    });
});
