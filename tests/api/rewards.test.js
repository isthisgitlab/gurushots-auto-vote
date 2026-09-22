/**
 * Tests for api/rewards.js — the prize-claim endpoints. Focus: form-body
 * encoding of dynamic values, the []/false-on-failure contracts callers rely
 * on, and required-argument guards.
 */

const {
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
} = require('../../src/js/api/rewards');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
}));

const { makePostRequest } = require('../../src/js/api/api-client');
const token = 'tok-123';

beforeEach(() => jest.clearAllMocks());

describe('getMyCompletedChallenges', () => {
    test('posts start/limit with WEB headers and returns completed_challenges', async () => {
        makePostRequest.mockResolvedValueOnce({ completed_challenges: [{ id: 1 }] });
        const items = await getMyCompletedChallenges(token, 40, 20);
        const [url, headers, body] = makePostRequest.mock.calls[0];
        expect(url).toBe('https://api.gurushots.com/rest/get_my_completed_challenges');
        expect(headers).toEqual(expect.objectContaining({ 'x-env': 'WEB', 'x-token': token }));
        expect(body).toBe('start=40&limit=20');
        expect(items).toEqual([{ id: 1 }]);
    });

    test('defaults to the first page of 20', async () => {
        makePostRequest.mockResolvedValueOnce({ completed_challenges: [] });
        await getMyCompletedChallenges(token);
        expect(makePostRequest.mock.calls[0][2]).toBe('start=0&limit=20');
    });

    test('returns [] on null / malformed payload', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getMyCompletedChallenges(token)).toEqual([]);
        makePostRequest.mockResolvedValueOnce({ success: true });
        expect(await getMyCompletedChallenges(token)).toEqual([]);
    });

    test('throws without a token', async () => {
        await expect(getMyCompletedChallenges('')).rejects.toThrow('rewards: token is required');
    });
});

describe('claimChallengeResources', () => {
    test('posts an encoded challenge_id and maps success', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        expect(await claimChallengeResources('13&x=1', token)).toBe(true);
        const [url, , body] = makePostRequest.mock.calls[0];
        expect(url).toBe('https://api.gurushots.com/rest/claim_resources');
        expect(body).toBe('challenge_id=13%26x%3D1');
    });

    test('false on success:false and on null', async () => {
        makePostRequest.mockResolvedValueOnce({ success: false });
        expect(await claimChallengeResources(1, token)).toBe(false);
        makePostRequest.mockResolvedValueOnce(null);
        expect(await claimChallengeResources(1, token)).toBe(false);
    });

    test('throws without an id or token', async () => {
        await expect(claimChallengeResources(null, token)).rejects.toThrow('challengeId is required');
        await expect(claimChallengeResources(1, '')).rejects.toThrow('token is required');
    });
});

describe('getMyMissions', () => {
    test('posts an empty body and returns list', async () => {
        makePostRequest.mockResolvedValueOnce({ list: [{ id: 7 }], success: true });
        expect(await getMyMissions(token)).toEqual([{ id: 7 }]);
        const [url, , body] = makePostRequest.mock.calls[0];
        expect(url).toBe('https://api.gurushots.com/rest/get_my_missions');
        expect(body).toBe('');
    });

    test('returns [] on null / malformed payload', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getMyMissions(token)).toEqual([]);
        makePostRequest.mockResolvedValueOnce({ list: 'nope' });
        expect(await getMyMissions(token)).toEqual([]);
    });

    test('throws without a token', async () => {
        await expect(getMyMissions(undefined)).rejects.toThrow('token is required');
    });
});

describe('claimMissionPrize', () => {
    test('posts an encoded mission_id and maps success', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        expect(await claimMissionPrize(42300941, token)).toBe(true);
        const [url, , body] = makePostRequest.mock.calls[0];
        expect(url).toBe('https://api.gurushots.com/rest/claim_mission_prizes');
        expect(body).toBe('mission_id=42300941');
    });

    test('false on success:false and on null', async () => {
        makePostRequest.mockResolvedValueOnce({ success: false });
        expect(await claimMissionPrize(1, token)).toBe(false);
        makePostRequest.mockResolvedValueOnce(null);
        expect(await claimMissionPrize(1, token)).toBe(false);
    });

    test('throws without an id or token', async () => {
        await expect(claimMissionPrize('', token)).rejects.toThrow('missionId is required');
        await expect(claimMissionPrize(1, null)).rejects.toThrow('token is required');
    });
});
