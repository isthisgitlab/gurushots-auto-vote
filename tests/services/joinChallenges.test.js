/**
 * Tests for services/joinChallenges.js — the paid-spend safety model:
 * photo-first ordering, unlock/submit idempotency, the double-spend lock,
 * budget accounting, cancellation, and the null-bankroll fail-safe.
 */

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), challengeTag: (c) => `challenge ${c?.id}` };
});
jest.mock('../../src/js/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/js/services/autoFill', () => ({
    fetchCandidatesForChallenge: jest.fn(async () => [{ id: 'imgA', permission: { allowed: true } }]),
    resolveSemanticScores: jest.fn(async () => null),
}));
jest.mock('../../src/js/services/photoPicker', () => ({
    pickPhotosForChallenge: jest.fn(() => ['imgA']),
}));
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn((key) => {
        const map = {
            autoJoin: true,
            autoJoinAll: true,
            autoJoinTypes: '',
            autoJoinMaxCoins: 150,
            autoJoinCycleCoinBudget: 300,
            fillWithoutTagMatch: true,
        };
        return map[key];
    }),
    getTitleProfile: jest.fn(() => null),
    getEffectiveTagSetting: jest.fn(() => []),
}));

const cancellation = require('../../src/js/voting/cancellation');
const photoPicker = require('../../src/js/services/photoPicker');
const settings = require('../../src/js/settings');
const {
    performJoin,
    runJoinPass,
    joinChallengeSingle,
    resolveJoinSetting,
    inFlight,
} = require('../../src/js/services/joinChallenges');

const makeStore = () => {
    let s = null;
    return { readRaw: () => s, writeRaw: (d) => (s = d) };
};
const makeDeps = (over = {}) => ({
    getMemberChallenges: jest.fn(async () => []),
    getBankroll: jest.fn(async () => ({ coins: 1000 })),
    coinsUnlock: jest.fn(async () => ({ ok: true })),
    submitToChallenge: jest.fn(async () => ({ ok: true })),
    getEligiblePhotos: jest.fn(),
    getImageData: jest.fn(),
    joinStateStore: makeStore(),
    ...over,
});

const DEFAULT_SETTINGS = {
    autoJoin: true,
    autoJoinAll: true,
    autoJoinTypes: '',
    autoJoinMaxCoins: 150,
    autoJoinCycleCoinBudget: 300,
    fillWithoutTagMatch: true,
};

beforeEach(() => {
    jest.clearAllMocks();
    cancellation.isCancelled.mockReturnValue(false);
    photoPicker.pickPhotosForChallenge.mockReturnValue(['imgA']);
    // Reset settings mocks to defaults so per-test overrides never leak.
    settings.getTitleProfile.mockReturnValue(null);
    settings.getEffectiveTagSetting.mockReturnValue([]);
    settings.getEffectiveSetting.mockImplementation((key) => DEFAULT_SETTINGS[key]);
    inFlight.clear();
});

describe('performJoin — ordering & idempotency', () => {
    test('free join submits, never unlocks', async () => {
        const deps = makeDeps();
        const res = await performJoin({ id: 1 }, 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).toHaveBeenCalledWith(1, ['imgA'], 'tok');
    });

    test('no eligible photo → skip, NO coins spent', async () => {
        photoPicker.pickPhotosForChallenge.mockReturnValue([]);
        const deps = makeDeps();
        const res = await performJoin({ id: 1 }, 'tok', deps, 100);
        expect(res.status).toBe('skipped-no-photo');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('paid join: unlock then submit, marker cleared on success', async () => {
        const deps = makeDeps();
        const res = await performJoin({ id: 7 }, 'tok', deps, 100);
        expect(res).toMatchObject({ status: 'joined', charged: 100 });
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        // marker cleared on success → no '7' key
        const state = JSON.parse(deps.joinStateStore.readRaw() || '{}');
        expect(state['7']).toBeUndefined();
    });

    test('unlock ok but submit fails → charged-pending-submit + marker persisted; retry does NOT re-unlock', async () => {
        const deps = makeDeps({
            submitToChallenge: jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true }),
        });
        const first = await performJoin({ id: 9 }, 'tok', deps, 100);
        expect(first).toMatchObject({ status: 'charged-pending-submit', charged: 100 });
        expect(JSON.parse(deps.joinStateStore.readRaw())['9']).toBeDefined();
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);

        // Retry: marker present → skip unlock, submit only.
        const second = await performJoin({ id: 9 }, 'tok', deps, 100);
        expect(second.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1); // NOT called again
        expect(JSON.parse(deps.joinStateStore.readRaw() || '{}')['9']).toBeUndefined();
    });

    test('unlock failure → failed-no-charge, no submit', async () => {
        const deps = makeDeps({ coinsUnlock: jest.fn(async () => ({ ok: false })) });
        const res = await performJoin({ id: 3 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('claim cannot be persisted → NO coins spent (no coinsUnlock call)', async () => {
        const brokenStore = {
            readRaw: () => null,
            writeRaw: () => {
                throw new Error('disk full');
            },
        };
        const deps = makeDeps({ joinStateStore: brokenStore });
        const res = await performJoin({ id: 11 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('claim is persisted BEFORE the charge (unlock sees the marker on disk)', async () => {
        const store = makeStore();
        const deps = makeDeps({
            joinStateStore: store,
            coinsUnlock: jest.fn(async (id) => {
                // The claim must already be on disk at the moment we spend.
                expect(JSON.parse(store.readRaw())[String(id)]).toBeDefined();
                return { ok: true };
            }),
        });
        const res = await performJoin({ id: 12 }, 'tok', deps, 100);
        expect(res.status).toBe('joined');
    });

    test('in-flight lock rejects a concurrent join for the same challenge', async () => {
        inFlight.add('5');
        const deps = makeDeps();
        const res = await performJoin({ id: 5 }, 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancellation before unlock → failed-no-charge, no spend', async () => {
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps();
        const res = await performJoin({ id: 8 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancelling a retry of an already-charged join reports pending-submit, not "no charge"', async () => {
        const store = makeStore();
        store.writeRaw(JSON.stringify({ 14: { unlockedAt: 1 } })); // prior cycle already unlocked
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps({ joinStateStore: store });
        const res = await performJoin({ id: 14 }, 'tok', deps, 100);
        expect(res.status).toBe('charged-pending-submit');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('corrupt join-state → refuse to spend (fail-safe)', async () => {
        const corruptStore = { readRaw: () => 'not json{{', writeRaw: jest.fn() };
        const deps = makeDeps({ joinStateStore: corruptStore });
        const res = await performJoin({ id: 15 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock held → busy, no spend', async () => {
        const deps = makeDeps({ acquireUnlockLock: jest.fn(() => ({ ok: false, release: () => {} })) });
        const res = await performJoin({ id: 16 }, 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock is released after the unlock section', async () => {
        const release = jest.fn();
        const deps = makeDeps({ acquireUnlockLock: jest.fn(() => ({ ok: true, release })) });
        await performJoin({ id: 17 }, 'tok', deps, 100);
        expect(release).toHaveBeenCalledTimes(1);
    });
});

describe('resolveJoinSetting — title profile (.values)', () => {
    test('reads the override from profile.values, not off the profile object', () => {
        settings.getTitleProfile.mockReturnValue({ name: 'p', values: { autoJoinMaxCoins: 50 } });
        settings.getEffectiveSetting.mockReturnValue(999);
        expect(resolveJoinSetting('autoJoinMaxCoins', { title: 'X' })).toBe(50);
    });

    test('suppressed profile falls back to the global default', () => {
        settings.getTitleProfile.mockReturnValue({ name: 'p', values: { autoJoinMaxCoins: 50 }, suppressed: true });
        settings.getEffectiveSetting.mockReturnValue(999);
        expect(resolveJoinSetting('autoJoinMaxCoins', { title: 'X' })).toBe(999);
    });

    test('no profile → global default', () => {
        settings.getTitleProfile.mockReturnValue(null);
        settings.getEffectiveSetting.mockReturnValue(7);
        expect(resolveJoinSetting('autoJoinMaxCoins', { title: 'X' })).toBe(7);
    });
});

describe('runJoinPass', () => {
    test('does nothing when autoJoin is off', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : undefined));
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('joins free + affordable paid, respects the per-cycle budget', async () => {
        // budget 300, two paid @200 → only the first affordable
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
                autoJoin: true,
                autoJoinAll: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 200, type: 'flash' },
                { id: 3, join_coins: 200, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => ({ coins: 1000 })),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(2); // free + first paid
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        const statuses = res.results.map((r) => r.status);
        expect(statuses).toContain('skipped:over-cycle-budget');
    });

    test('a candidate that throws does not abort the rest of the pass', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => DEFAULT_SETTINGS[k]);
        const submit = jest
            .fn()
            .mockRejectedValueOnce(new Error('boom')) // first candidate blows up
            .mockResolvedValue({ ok: true }); // second joins fine
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'flash' },
            ]),
            submitToChallenge: submit,
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results.map((r) => r.status)).toEqual(['error', 'joined']);
        expect(res.joined).toBe(1);
    });

    test('getBankroll throwing → paid skipped, free still joins', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => DEFAULT_SETTINGS[k]);
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => {
                throw new Error('network');
            }),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(1);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('null bankroll → paid skipped, free still joins', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
                autoJoin: true,
                autoJoinAll: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => null),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(1);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });
});

describe('joinChallengeSingle — manual', () => {
    test('paid without spendCoins → needs-confirm, no spend', async () => {
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [{ id: 2, join_coins: 100, type: 'flash' }]),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: false });
        expect(res).toMatchObject({ status: 'needs-confirm', cost: 100 });
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('unavailable when not in the open list', async () => {
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => []) });
        const res = await joinChallengeSingle(999, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('unavailable');
    });

    test('paid with spendCoins joins after affordability check', async () => {
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [{ id: 2, join_coins: 100, type: 'flash' }]),
            getBankroll: jest.fn(async () => ({ coins: 500 })),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
    });
});
