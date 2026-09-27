/**
 * Defensive-input tests for the real-strategy applyBoost (strategies/real/applyBoost.ts)
 * and api/boost.ts that complement boost.test.ts:
 * missing / nullish ids, a picked entry without an id, and missing member data.
 * The entry picker (VotingLogic.pickBoostEntry) is mocked here so each guard
 * can be reached directly.
 */

jest.mock('../../src/js/services/VotingLogic', () => ({ pickBoostEntry: jest.fn() }));

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token: string) => ({ 'x-token': token })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

const { pickBoostEntry } = jest.mocked(require('../../src/js/services/VotingLogic') as typeof VotingLogicModule);
const { makePostRequest } = jest.mocked(require('../../src/js/api/api-client') as typeof api_clientModule);
const { ENDPOINTS } = require('../../src/js/api/constants') as typeof constantsModule;
import logger = require('../../src/js/logger');
import type * as VotingLogicModule from '../../src/js/services/VotingLogic';
import type * as api_clientModule from '../../src/js/api/api-client';
import type * as constantsModule from '../../src/js/api/constants';
import type * as boostModule from '../../src/js/api/boost';
import type * as applyBoostModule from '../../src/js/strategies/real/applyBoost';
const { applyBoostToEntry } = require('../../src/js/api/boost') as typeof boostModule;
const { applyBoost } = require('../../src/js/strategies/real/applyBoost') as typeof applyBoostModule;
import type { CategoryLogger } from '../../src/js/logger';
import type { RankingEntry } from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';

const scopedErrors = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) =>
            jest.mocked(r.value as CategoryLogger).error.mock.calls.map((call) => [call[0], call[1]]),
        );

beforeEach(() => {
    jest.clearAllMocks();
});

describe('applyBoost guards', () => {
    test('a challenge without member data is rejected without a request', async () => {
        await expect(applyBoost(invalid({ id: 5 }), 'tok')).resolves.toBeNull();

        expect(pickBoostEntry).not.toHaveBeenCalled();
        expect(makePostRequest).not.toHaveBeenCalled();
        expect(scopedErrors()).toEqual([['No entries available for boosting', { challengeId: '5' }]]);
    });

    test('a missing challenge id is reported as an empty id', async () => {
        await expect(applyBoost(invalid({ member: { ranking: { entries: [] } } }), 'tok')).resolves.toBeNull();

        expect(scopedErrors()).toEqual([['No entries available for boosting', { challengeId: '' }]]);
    });

    test('a picked entry with no id is rejected without a request', async () => {
        const challenge = { id: 9, member: { ranking: { entries: [invalid<RankingEntry>({ id: null })] } } };
        pickBoostEntry.mockReturnValue(challenge.member.ranking.entries[0]);

        await expect(applyBoost(invalid(challenge), 'tok')).resolves.toBeNull();

        expect(pickBoostEntry).toHaveBeenCalledWith(challenge, '9');
        expect(makePostRequest).not.toHaveBeenCalled();
        expect(scopedErrors()).toEqual([['Selected boost entry has no id', { challengeId: '9' }]]);
        expect(challenge.member.ranking.entries[0].boosted).toBeUndefined();
    });

    test('a successful boost marks the picked entry as boosted', async () => {
        const entry: RankingEntry = { id: 'img-1' };
        const challenge = { id: 9, member: { ranking: { entries: [entry] } } };
        pickBoostEntry.mockReturnValue(entry);
        makePostRequest.mockResolvedValue({ success: true });

        await expect(applyBoost(invalid(challenge), 'tok')).resolves.toEqual({ success: true });

        expect(makePostRequest).toHaveBeenCalledWith(ENDPOINTS.boostPhoto, expect.any(Object), 'c_id=9&image_id=img-1');
        expect(entry.boosted).toBe(true);
    });

    test('a failed boost leaves the picked entry unmarked', async () => {
        const entry: RankingEntry = { id: 'img-1' };
        pickBoostEntry.mockReturnValue(entry);
        makePostRequest.mockResolvedValue(null);

        await expect(
            applyBoost(invalid({ id: 9, member: { ranking: { entries: [entry] } } }), 'tok'),
        ).resolves.toBeNull();
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
