import { PER_ID_JOIN_KEYS } from '../../src/ts/core/services/joinChallenges/settingsResolution';
import { JOIN_KEPT_KEYS } from '../../src/ts/core/settings/staleChallengeCleanup';

describe('the join settings that read a per-id override', () => {
    test('are the keys the stale-settings cleanup keeps for a challenge that is not joined yet', () => {
        expect([...PER_ID_JOIN_KEYS].sort()).toEqual([...JOIN_KEPT_KEYS].sort());
    });
});
