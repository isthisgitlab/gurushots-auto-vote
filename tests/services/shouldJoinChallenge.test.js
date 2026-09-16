/**
 * Tests for VotingLogic.shouldJoinChallenge — the pure auto-join decision.
 * Model: once enabled, the DEFAULT scope is join everything; a non-empty include
 * list narrows; the exclude list subtracts; a title profile bypasses both. Coin
 * caps gate paid joins (both 0 = free only).
 */

const { shouldJoinChallenge } = require('../../src/js/services/VotingLogic');

const base = {
    challenge: { id: 1, type: 'flash', join_coins: 0 },
    bankroll: { coins: 1000 },
    remainingBudget: 1000,
    includeTypes: [],
    excludeTypes: [],
    maxCoins: 0,
    hasProfileMatch: false,
};
const call = (over) => shouldJoinChallenge({ ...base, ...over });

describe('scope (default = all)', () => {
    test('joins by default when nothing narrows it', () => {
        expect(call({})).toMatchObject({ join: true, reason: 'free' });
    });
    test('a non-empty include list narrows to those types', () => {
        expect(call({ includeTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
        expect(call({ includeTypes: ['contest'] }).reason).toBe('out-of-scope');
    });
    test('include match is case-insensitive on the challenge type', () => {
        expect(call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, includeTypes: ['flash'] }).join).toBe(true);
    });
    test('a title-profile match joins even outside the include list', () => {
        expect(call({ includeTypes: ['contest'], hasProfileMatch: true })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('a typeless challenge is out of scope only when an include list is set', () => {
        expect(call({ challenge: { id: 9, type: '', join_coins: 0 } })).toMatchObject({ join: true, reason: 'free' });
        expect(call({ challenge: { id: 9, type: '', join_coins: 0 }, includeTypes: ['flash'] }).reason).toBe(
            'out-of-scope',
        );
    });
});

describe('exclude types (default-all minus excludes)', () => {
    test('excluded type is skipped', () => {
        expect(call({ excludeTypes: ['flash'] })).toMatchObject({ join: false, reason: 'excluded-type' });
    });
    test('a non-excluded type still joins ("all except X")', () => {
        expect(
            call({ challenge: { id: 1, type: 'contest', join_coins: 0 }, excludeTypes: ['flash', 'exhibition'] }),
        ).toMatchObject({ join: true, reason: 'free' });
    });
    test('a title-profile match bypasses the exclude veto', () => {
        expect(call({ hasProfileMatch: true, excludeTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
    });
    test('a title-profile match bypasses BOTH an exclude and a non-matching include list at once', () => {
        expect(call({ hasProfileMatch: true, includeTypes: ['contest'], excludeTypes: ['flash'] })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('exclude overrides an explicit include of the same type', () => {
        expect(call({ includeTypes: ['flash'], excludeTypes: ['flash'] }).reason).toBe('excluded-type');
    });
    test('exclude match is case-insensitive on the challenge type', () => {
        expect(call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, excludeTypes: ['flash'] }).reason).toBe(
            'excluded-type',
        );
    });
    test('exclusion short-circuits before the paid gate', () => {
        const r = call({
            challenge: { id: 2, type: 'flash', join_coins: 100 },
            excludeTypes: ['flash'],
            maxCoins: 250,
            remainingBudget: 500,
            bankroll: { coins: 500 },
        });
        expect(r.reason).toBe('excluded-type');
    });
    test('a typeless challenge is never excluded and joins by default', () => {
        expect(call({ challenge: { id: 3, type: '', join_coins: 0 }, excludeTypes: ['flash'] })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
});

describe('paid gate', () => {
    const paid = { challenge: { id: 2, type: 'flash', join_coins: 100 } };

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
        expect(call({ bankroll: null })).toMatchObject({ join: true, reason: 'free' });
    });
    test('affordable within both caps joins', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 300, bankroll: { coins: 500 } })).toMatchObject({
            join: true,
            needsCoins: 100,
            reason: 'paid',
        });
    });
});
