/**
 * Failure-contract parity between the real and mock API surfaces for the
 * missing-token case. The real api modules NEVER reject on a missing
 * token — they resolve a safe empty shape (or null/undefined) after the
 * transport-level request fails. The mock surface must resolve the SAME
 * shapes, otherwise callers that only check falsiness behave differently
 * in mock mode than in real mode.
 *
 * Real surface: makePostRequest is mocked to resolve null, which is
 * exactly what the real api-client does on any transport/HTTP failure —
 * so each method exercises its own failure branch.
 */

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn().mockResolvedValue(null),
    makeGetRequest: jest.fn().mockResolvedValue(null),
    createCommonHeaders: jest.fn(() => ({})),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

jest.mock('../../src/js/settings.js', () => ({
    getSetting: jest.fn(() => null),
    getEffectiveSetting: jest.fn(() => 1),
    loadSettings: jest.fn(() => ({ mock: true })),
    SETTINGS_SCHEMA: { exposure: { default: 100 } },
}));

const realChallenges = require('../../src/js/api/challenges');
const realVoting = require('../../src/js/api/voting');
const realBoost = require('../../src/js/api/boost');
const { mockApiClient } = require('../../src/js/mock/index');

// Contract table: [name, real call, mock call, expected resolve shape check]
const challengeArg = {
    id: '1',
    title: 'C',
    url: 'u',
    member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [] } },
};

describe('no-token failure contract: neither surface rejects', () => {
    test('getActiveChallenges resolves { challenges: [] } on both surfaces', async () => {
        await expect(realChallenges.getActiveChallenges(null)).resolves.toEqual({ challenges: [] });
        await expect(mockApiClient.getActiveChallenges(null)).resolves.toEqual({ challenges: [] });
    });

    test('getVoteImages resolves null on both surfaces', async () => {
        await expect(realVoting.getVoteImages(challengeArg, null)).resolves.toBeNull();
        await expect(mockApiClient.getVoteImages(challengeArg, null)).resolves.toBeNull();
    });

    test('submitVotes resolves undefined on both surfaces', async () => {
        const voteImages = { images: [], challenge: challengeArg, voting: {} };
        await expect(realVoting.submitVotes(voteImages, null)).resolves.toBeUndefined();
        await expect(mockApiClient.submitVotes(voteImages, null)).resolves.toBeUndefined();
    });

    test('applyBoost resolves null on both surfaces', async () => {
        // Give the challenge a pickable entry so the REAL applyBoost gets
        // past the no-entries guard and actually reaches the request path
        // (_postBoost → makePostRequest resolving null on failure) — the
        // branch this contract is about.
        const boostable = {
            ...challengeArg,
            member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: 'img1' }] } },
        };
        await expect(realBoost.applyBoost(boostable, null)).resolves.toBeNull();
        await expect(mockApiClient.applyBoost(boostable, null)).resolves.toBeNull();
    });

    test('applyBoostToEntry resolves null on both surfaces', async () => {
        await expect(realBoost.applyBoostToEntry('1', 'img', null)).resolves.toBeNull();
        await expect(mockApiClient.applyBoostToEntry('1', 'img', null)).resolves.toBeNull();
    });
});
