/**
 * Defensive-input tests for api/boost.js that complement boost.test.js:
 * missing / nullish ids, a picked entry without an id, and missing member data.
 * The entry picker (VotingLogic.pickBoostEntry) is mocked here so each guard
 * can be reached directly.
 */

jest.mock('../../src/js/services/VotingLogic', () => ({ pickBoostEntry: jest.fn() }));

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token) => ({ 'x-token': token })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

const { pickBoostEntry } = require('../../src/js/services/VotingLogic');
const { makePostRequest } = require('../../src/js/api/api-client');
const { ENDPOINTS } = require('../../src/js/api/constants');
const logger = require('../../src/js/logger');
const { applyBoost, applyBoostToEntry } = require('../../src/js/api/boost');

const scopedErrors = () =>
    logger.withCategory.mock.results.flatMap((r) => r.value.error.mock.calls.map((call) => [call[0], call[1]]));

beforeEach(() => {
    jest.clearAllMocks();
});

describe('applyBoost guards', () => {
    test('a challenge without member data is rejected without a request', async () => {
        await expect(applyBoost({ id: 5 }, 'tok')).resolves.toBeNull();

        expect(pickBoostEntry).not.toHaveBeenCalled();
        expect(makePostRequest).not.toHaveBeenCalled();
        expect(scopedErrors()).toEqual([['No entries available for boosting', { challengeId: '5' }]]);
    });

    test('a missing challenge id is reported as an empty id', async () => {
        await expect(applyBoost({ member: { ranking: { entries: [] } } }, 'tok')).resolves.toBeNull();

        expect(scopedErrors()).toEqual([['No entries available for boosting', { challengeId: '' }]]);
    });

    test('a picked entry with no id is rejected without a request', async () => {
        const challenge = { id: 9, member: { ranking: { entries: [{ id: null }] } } };
        pickBoostEntry.mockReturnValue(challenge.member.ranking.entries[0]);

        await expect(applyBoost(challenge, 'tok')).resolves.toBeNull();

        expect(pickBoostEntry).toHaveBeenCalledWith(challenge, '9');
        expect(makePostRequest).not.toHaveBeenCalled();
        expect(scopedErrors()).toEqual([['Selected boost entry has no id', { challengeId: '9' }]]);
        expect(challenge.member.ranking.entries[0].boosted).toBeUndefined();
    });

    test('a successful boost marks the picked entry as boosted', async () => {
        const entry = { id: 'img-1' };
        const challenge = { id: 9, member: { ranking: { entries: [entry] } } };
        pickBoostEntry.mockReturnValue(entry);
        makePostRequest.mockResolvedValue({ success: true });

        await expect(applyBoost(challenge, 'tok')).resolves.toEqual({ success: true });

        expect(makePostRequest).toHaveBeenCalledWith(ENDPOINTS.boostPhoto, expect.any(Object), 'c_id=9&image_id=img-1');
        expect(entry.boosted).toBe(true);
    });

    test('a failed boost leaves the picked entry unmarked', async () => {
        const entry = { id: 'img-1' };
        pickBoostEntry.mockReturnValue(entry);
        makePostRequest.mockResolvedValue(null);

        await expect(applyBoost({ id: 9, member: { ranking: { entries: [entry] } } }, 'tok')).resolves.toBeNull();
        expect(entry.boosted).toBeUndefined();
    });
});

describe('applyBoostToEntry nullish ids', () => {
    test('null/undefined ids are posted as empty strings, never "null"/"undefined"', async () => {
        makePostRequest.mockResolvedValue({ success: true });

        await applyBoostToEntry(null, undefined, 'tok');

        expect(makePostRequest).toHaveBeenCalledWith(ENDPOINTS.boostPhoto, expect.any(Object), 'c_id=&image_id=');
    });
});
