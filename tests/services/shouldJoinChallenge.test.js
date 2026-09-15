/**
 * Tests for VotingLogic.shouldJoinChallenge — the pure auto-join decision.
 * Covers scope (profile/all/type), the paid gate, both coin-cap sentinels, and
 * the null-bankroll fail-safe.
 */

const { shouldJoinChallenge } = require('../../src/js/services/VotingLogic');

const base = {
    challenge: { id: 1, type: 'flash', join_coins: 0 },
    bankroll: { coins: 1000 },
    remainingBudget: 1000,
    allowAll: false,
    allowTypes: [],
    maxCoins: 0,
    hasProfileMatch: false,
};
const call = (over) => shouldJoinChallenge({ ...base, ...over });

describe('scope', () => {
    test('out of scope when nothing matches', () => {
        expect(call({}).join).toBe(false);
        expect(call({}).reason).toBe('out-of-scope');
    });
    test('profile match brings a free challenge in scope', () => {
        expect(call({ hasProfileMatch: true })).toMatchObject({ join: true, reason: 'free' });
    });
    test('allowAll brings it in scope', () => {
        expect(call({ allowAll: true })).toMatchObject({ join: true, reason: 'free' });
    });
    test('type match (challenge.type normalized) brings it in scope', () => {
        // allowTypes arrives pre-lowercased (parseTypeList); the challenge.type
        // is lowercased before comparison, so an upper-case type still matches.
        expect(call({ allowTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
        expect(call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, allowTypes: ['flash'] }).join).toBe(true);
        expect(call({ allowTypes: ['contest'] }).join).toBe(false);
    });
});

describe('exclude types (deny wins over scope)', () => {
    test('excluded type vetoes even with allowAll', () => {
        const r = call({ allowAll: true, excludeTypes: ['flash'] });
        expect(r).toMatchObject({ join: false, reason: 'excluded-type' });
    });
    test('a title-profile match bypasses the exclude veto (specific beats general)', () => {
        // A profiled title is a deliberate opt-in and still joins even if its
        // type is excluded.
        expect(call({ hasProfileMatch: true, excludeTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
    });
    test('exclude overrides an explicit include of the same type', () => {
        expect(call({ allowTypes: ['flash'], excludeTypes: ['flash'] }).reason).toBe('excluded-type');
    });
    test('a non-excluded type still joins under allowAll (the "all except X" case)', () => {
        expect(
            call({
                challenge: { id: 1, type: 'contest', join_coins: 0 },
                allowAll: true,
                excludeTypes: ['flash', 'exhibition'],
            }),
        ).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('exclude match is case-insensitive on the challenge type', () => {
        expect(
            call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, allowAll: true, excludeTypes: ['flash'] })
                .reason,
        ).toBe('excluded-type');
    });
    test('exclusion short-circuits before the paid gate (an affordable paid excluded type is still vetoed)', () => {
        const r = call({
            challenge: { id: 2, type: 'flash', join_coins: 100 },
            allowAll: true,
            excludeTypes: ['flash'],
            maxCoins: 250,
            remainingBudget: 500,
            bankroll: { coins: 500 },
        });
        expect(r.reason).toBe('excluded-type');
    });
    test('a typeless challenge is never excluded (guard: type must be non-empty)', () => {
        expect(
            call({ challenge: { id: 3, type: '', join_coins: 0 }, allowAll: true, excludeTypes: ['flash'] }),
        ).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
});

describe('paid gate', () => {
    const paid = { challenge: { id: 2, type: 'flash', join_coins: 100 }, allowAll: true };

    test('both caps at 0 disable paid (per-challenge sentinel)', () => {
        expect(call({ ...paid, maxCoins: 0, remainingBudget: 0 }).reason).toBe('paid-disabled');
    });
    test('per-cycle budget 0 alone disables paid even with a per-challenge cap', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 0 }).reason).toBe('over-cycle-budget');
    });
    test('over per-challenge cap', () => {
        expect(call({ ...paid, maxCoins: 50, remainingBudget: 1000 }).reason).toBe('over-per-challenge-cap');
    });
    test('insufficient coins', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 1000, bankroll: { coins: 50 } }).reason).toBe(
            'insufficient-coins',
        );
    });
    test('null bankroll blocks paid (fail-safe) but allows free', () => {
        expect(call({ ...paid, maxCoins: 150, bankroll: null }).reason).toBe('balance-unknown');
        expect(call({ allowAll: true, bankroll: null })).toMatchObject({ join: true, reason: 'free' });
    });
    test('affordable within both caps joins', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 300, bankroll: { coins: 500 } })).toMatchObject({
            join: true,
            needsCoins: 100,
            reason: 'paid',
        });
    });
});
