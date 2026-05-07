/**
 * Tests for turboImageIndex selection in VotingLogic.shouldApplyTurbo
 *
 * Covers:
 *   - 1-indexed values pick the matching entry
 *   - Out-of-range positives clamp to the last entry
 *   - Sentinel value 0 always selects the last entry, regardless of count
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const buildChallenge = (entries) => ({
    id: 'c1',
    close_time: 1_000_000,
    member: {
        turbo: {state: 'WON'},
        ranking: {entries},
    },
});

const mockSettings = (turboImageIndex) => {
    settings.getEffectiveSetting = jest.fn((key) => {
        switch (key) {
        case 'useTurbo': return true;
        case 'turboImageIndex': return turboImageIndex;
        case 'turboApplyWhenBoostActive': return true;
        case 'turboTime': return 60_000;
        default: return undefined;
        }
    });
};

describe('shouldApplyTurbo entry selection', () => {
    const now = 999_990; // close_time - now = 10s, well inside the mocked turboTime window

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('1-indexed value picks the matching entry', () => {
        mockSettings(2);
        const challenge = buildChallenge([
            {id: 'e1'}, {id: 'e2'}, {id: 'e3'},
        ]);
        const result = VotingLogic.shouldApplyTurbo(challenge, now);
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('e2');
    });

    test('out-of-range positive clamps to last entry', () => {
        mockSettings(99);
        const challenge = buildChallenge([
            {id: 'e1'}, {id: 'e2'}, {id: 'e3'},
        ]);
        const result = VotingLogic.shouldApplyTurbo(challenge, now);
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('e3');
    });

    test('sentinel 0 picks last entry on a 1-entry challenge', () => {
        mockSettings(0);
        const result = VotingLogic.shouldApplyTurbo(buildChallenge([{id: 'only'}]), now);
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('only');
    });

    test('sentinel 0 picks last entry on a 2-entry challenge', () => {
        mockSettings(0);
        const result = VotingLogic.shouldApplyTurbo(
            buildChallenge([{id: 'first'}, {id: 'last'}]),
            now,
        );
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('last');
    });

    test('sentinel 0 picks last entry on a 5-entry challenge', () => {
        mockSettings(0);
        const result = VotingLogic.shouldApplyTurbo(
            buildChallenge([
                {id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}, {id: 'e'},
            ]),
            now,
        );
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('e');
    });
});
