/**
 * Tests for boostImageIndex selection in api/boost.applyBoost and the
 * shared resolveEntryIndex helper used by both turbo and boost picks.
 *
 * GuruShots permits at most one turbo per challenge, so the picker only
 * ever needs a single-step backward fallback: if the configured entry has
 * turbo, the entry one position earlier (wrapping past entry 1 to the last
 * entry) is guaranteed to be turbo-free, unless the challenge has only one
 * entry and that one has turbo.
 *
 * Covers:
 *   - 1-indexed values pick the matching entry when no turbo conflict
 *   - Out-of-range positives clamp to the last entry
 *   - Sentinel 0 always picks the last entry
 *   - When the configured entry has turbo, picker falls back one slot
 *     (wrapping past entry 1 to the last entry)
 *   - When the only entry has turbo, applyBoost returns null
 *
 * The picker reads `boostImageIndex` via settings.getEffectiveSetting,
 * which we mock here for determinism.
 */

const settings = require('../../src/js/settings');
const { applyBoost } = require('../../src/js/api/boost');
const { resolveEntryIndex, pickEntryAvoidingConflict } = require('../../src/js/services/VotingLogic');
const apiClient = require('../../src/js/api/api-client');

jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
}));

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn(() => ({ 'x-token': 'mock-token' })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
    })),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    success: jest.fn(),
}));

const setBoostIndex = (value) => {
    settings.getEffectiveSetting.mockImplementation((key) => (key === 'boostImageIndex' ? value : undefined));
};

const buildChallenge = (entries) => ({
    id: 'c1',
    title: 'Test',
    member: { ranking: { entries } },
});

const lastBoostedImageId = () => {
    const lastCall = apiClient.makePostRequest.mock.calls.at(-1);
    if (!lastCall) return null;
    const body = lastCall[2];
    const matched = body.match(/image_id=([^&]+)/);
    return matched ? decodeURIComponent(matched[1]) : null;
};

describe('applyBoost - boostImageIndex selection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        apiClient.makePostRequest.mockResolvedValue({ success: true });
    });

    test('1-indexed value picks the matching entry when no turbo conflict', async () => {
        setBoostIndex(2);
        const challenge = buildChallenge([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e2');
    });

    test('out-of-range positive clamps to last entry', async () => {
        setBoostIndex(99);
        const challenge = buildChallenge([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e3');
    });

    test('sentinel 0 picks last entry on a 1-entry challenge', async () => {
        setBoostIndex(0);
        await applyBoost(buildChallenge([{ id: 'only' }]), 'tok');
        expect(lastBoostedImageId()).toBe('only');
    });

    test('sentinel 0 picks last entry on a 2-entry challenge', async () => {
        setBoostIndex(0);
        await applyBoost(buildChallenge([{ id: 'first' }, { id: 'last' }]), 'tok');
        expect(lastBoostedImageId()).toBe('last');
    });

    test('sentinel 0 picks last entry on a 5-entry challenge', async () => {
        setBoostIndex(0);
        await applyBoost(buildChallenge([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]), 'tok');
        expect(lastBoostedImageId()).toBe('e');
    });

    test('primary index 1 with turboed first entry wraps to last entry', async () => {
        setBoostIndex(1);
        const challenge = buildChallenge([{ id: 'e1', turbo: true }, { id: 'e2' }, { id: 'e3' }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e3');
    });

    test('primary index 2 with turboed second entry walks back to entry 1', async () => {
        setBoostIndex(2);
        const challenge = buildChallenge([{ id: 'e1' }, { id: 'e2', turbo: true }, { id: 'e3' }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e1');
    });

    test('sentinel 0 with last entry turboed walks back to second-to-last', async () => {
        setBoostIndex(0);
        const challenge = buildChallenge([{ id: 'e1' }, { id: 'e2' }, { id: 'e3', turbo: true }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e2');
    });

    test('1-entry challenge with that entry turboed: applyBoost returns null (boost cannot apply)', async () => {
        setBoostIndex(1);
        const challenge = buildChallenge([{ id: 'e1', turbo: true }]);
        const result = await applyBoost(challenge, 'tok');
        expect(result).toBeNull();
        expect(apiClient.makePostRequest).not.toHaveBeenCalled();
    });

    test('2-entry challenge with primary turboed wraps to entry 2 (the only other entry)', async () => {
        setBoostIndex(1);
        const challenge = buildChallenge([{ id: 'e1', turbo: true }, { id: 'e2' }]);
        await applyBoost(challenge, 'tok');
        expect(lastBoostedImageId()).toBe('e2');
    });

    test('empty entries array: applyBoost returns null', async () => {
        setBoostIndex(1);
        const result = await applyBoost(buildChallenge([]), 'tok');
        expect(result).toBeNull();
        expect(apiClient.makePostRequest).not.toHaveBeenCalled();
    });

    test('picked entry without id: applyBoost returns null and skips POST', async () => {
        setBoostIndex(1);
        const challenge = buildChallenge([{ turbo: false }]);
        const result = await applyBoost(challenge, 'tok');
        expect(result).toBeNull();
        expect(apiClient.makePostRequest).not.toHaveBeenCalled();
    });
});

describe('resolveEntryIndex helper', () => {
    test('returns null for empty or missing arrays', () => {
        expect(resolveEntryIndex([], 1)).toBeNull();
        expect(resolveEntryIndex([], 0)).toBeNull();
        expect(resolveEntryIndex(null, 1)).toBeNull();
        expect(resolveEntryIndex(undefined, 1)).toBeNull();
    });

    test('sentinel 0 maps to last entry slot', () => {
        expect(resolveEntryIndex([{ id: 'a' }], 0)).toBe(0);
        expect(resolveEntryIndex([{ id: 'a' }, { id: 'b' }], 0)).toBe(1);
        expect(resolveEntryIndex([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 0)).toBe(2);
    });

    test('1-based positive values map to (n - 1) array slot', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(resolveEntryIndex(entries, 1)).toBe(0);
        expect(resolveEntryIndex(entries, 2)).toBe(1);
        expect(resolveEntryIndex(entries, 3)).toBe(2);
    });

    test('out-of-range positives clamp to last valid slot', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(resolveEntryIndex(entries, 4)).toBe(2);
        expect(resolveEntryIndex(entries, 99)).toBe(2);
    });

    test('non-integer or negative inputs fall through to slot 0', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(resolveEntryIndex(entries, NaN)).toBe(0);
        expect(resolveEntryIndex(entries, undefined)).toBe(0);
        expect(resolveEntryIndex(entries, null)).toBe(0);
        expect(resolveEntryIndex(entries, 1.5)).toBe(0);
        expect(resolveEntryIndex(entries, -1)).toBe(0);
        expect(resolveEntryIndex(entries, '2')).toBe(0);
    });
});

describe('pickEntryAvoidingConflict helper (direct unit tests)', () => {
    test('returns null for empty or missing entries', () => {
        expect(pickEntryAvoidingConflict([], 1, 'turbo')).toBeNull();
        expect(pickEntryAvoidingConflict(null, 1, 'turbo')).toBeNull();
        expect(pickEntryAvoidingConflict(undefined, 1, 'turbo')).toBeNull();
    });

    test('picks entry at 1-indexed slot when no conflict (conflictField=turbo)', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(pickEntryAvoidingConflict(entries, 2, 'turbo')).toEqual({ id: 'b' });
    });

    test('picks entry at 1-indexed slot when no conflict (conflictField=boosted)', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(pickEntryAvoidingConflict(entries, 3, 'boosted')).toEqual({ id: 'c' });
    });

    test('sentinel 0 picks last entry when no conflict', () => {
        const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(pickEntryAvoidingConflict(entries, 0, 'turbo')).toEqual({ id: 'c' });
    });

    test('walks backward one slot when configured entry has the conflict field', () => {
        const entries = [{ id: 'a' }, { id: 'b', boosted: true }, { id: 'c' }];
        expect(pickEntryAvoidingConflict(entries, 2, 'boosted')).toEqual({ id: 'a' });
    });

    test('wraps from slot 0 to last entry on conflict', () => {
        const entries = [{ id: 'a', turbo: true }, { id: 'b' }, { id: 'c' }];
        expect(pickEntryAvoidingConflict(entries, 1, 'turbo')).toEqual({ id: 'c' });
    });

    test('returns null when both primary slot and backward-fallback slot are conflicted', () => {
        const entries = [{ id: 'a', turbo: true }, { id: 'b' }, { id: 'c', turbo: true }];
        // Slot 0 (entry 1) is turboed → wraps to slot 2 (entry 3) which is also turboed → null
        expect(pickEntryAvoidingConflict(entries, 1, 'turbo')).toBeNull();
    });

    test('single-entry challenge with that entry conflicted returns null', () => {
        expect(pickEntryAvoidingConflict([{ id: 'only', turbo: true }], 1, 'turbo')).toBeNull();
        expect(pickEntryAvoidingConflict([{ id: 'only', boosted: true }], 0, 'boosted')).toBeNull();
    });
});
