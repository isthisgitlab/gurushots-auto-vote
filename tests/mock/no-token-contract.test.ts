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

jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(() => null),
    getEffectiveSetting: jest.fn(() => 1),
    loadSettings: jest.fn(() => ({ mock: true })),
    SETTINGS_SCHEMA: { exposure: { default: 100 } },
}));

import realChallenges = require('../../src/js/strategies/real/activeChallenges');
import realVoting = require('../../src/js/api/voting');
import type * as indexModule from '../../src/js/mock/index';
import type * as boostModule from '../../src/js/api/boost';
import type * as applyBoostModule from '../../src/js/strategies/real/applyBoost';
import type { Challenge, VoteImagesResponse } from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';
const realBoost: typeof boostModule & typeof applyBoostModule = {
    ...(require('../../src/js/api/boost') as typeof boostModule),
    ...(require('../../src/js/strategies/real/applyBoost') as typeof applyBoostModule),
};
const { mockApiClient } = require('../../src/js/mock/index') as typeof indexModule;

// Contract table: [name, real call, mock call, expected resolve shape check]
const challengeArg = invalid<Challenge>({
    id: '1',
    title: 'C',
    url: 'u',
    member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [] } },
});

describe('no-token failure contract: neither surface rejects', () => {
    test('getActiveChallenges resolves a flagged empty list on both surfaces', async () => {
        // The flag distinguishes "the fetch failed" from "you have no active challenges", so
        // an outage is not reported as a healthy empty pass. Both surfaces must carry it or
        // the shared voting pass would behave differently in mock mode.
        await expect(realChallenges.getActiveChallenges(invalid(null))).resolves.toEqual({
            challenges: [],
            fetchFailed: true,
        });
        await expect(mockApiClient.getActiveChallenges(invalid(null))).resolves.toEqual({
            challenges: [],
            fetchFailed: true,
        });
    });

    test('getVoteImages resolves null on both surfaces', async () => {
        await expect(realVoting.getVoteImages(challengeArg, invalid(null))).resolves.toBeNull();
        await expect(mockApiClient.getVoteImages(challengeArg, invalid(null))).resolves.toBeNull();
    });

    test('submitVotes resolves undefined on both surfaces', async () => {
        const voteImages = invalid<VoteImagesResponse>({ images: [], challenge: challengeArg, voting: {} });
        await expect(realVoting.submitVotes(voteImages, invalid(null))).resolves.toBeUndefined();
        await expect(mockApiClient.submitVotes(voteImages, invalid(null))).resolves.toBeUndefined();
    });

    test('applyBoost resolves null on both surfaces', async () => {
        // Give the challenge a pickable entry so the REAL applyBoost gets
        // past the no-entries guard and actually reaches the request path
        // (_postBoost → makePostRequest resolving null on failure) — the
        // branch this contract is about.
        const boostable = invalid<Challenge>({
            ...challengeArg,
            member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: 'img1' }] } },
        });
        await expect(realBoost.applyBoost(boostable, invalid(null))).resolves.toBeNull();
        await expect(mockApiClient.applyBoost(boostable, invalid(null))).resolves.toBeNull();
    });

    test('applyBoostToEntry resolves null on both surfaces', async () => {
        await expect(realBoost.applyBoostToEntry('1', 'img', invalid(null))).resolves.toBeNull();
        await expect(mockApiClient.applyBoostToEntry('1', 'img', invalid(null))).resolves.toBeNull();
    });
});
