/**
 * Tests for services/currencyActions.js — the live re-check before every
 * spend and the swap replacement pick (runs the real fill ranking pipeline
 * against a stubbed API strategy).
 */

const logger = require('../../src/js/logger');
const { __resetMemberIdCache } = require('../../src/js/services/autoFill');
const { unlockBoostWithKey, previewSwap, swapEntry, fillExposure } = require('../../src/js/services/currencyActions');

const NOW = () => Math.floor(Date.now() / 1000);
const FULL = { keys: 2, swaps: 2, fills: 2, coins: 0 };

const makeChallenge = (overrides = {}) => ({
    id: 555,
    title: 'Anything Goes',
    start_time: NOW() - 3600,
    close_time: NOW() + 3600,
    boost_enable: true,
    swap_enable: true,
    swap_locked: false,
    fill_enable: true,
    fill_locked: false,
    member: {
        boost: { state: 'LOCKED', timeout: null },
        ranking: {
            exposure: { exposure_factor: 50 },
            entries: [
                { id: 'entered', member_id: 'mem1' },
                { id: 'old', member_id: 'mem1' },
            ],
            swaps: [{ id: 'swapped-before' }],
        },
    },
    ...overrides,
});

const photo = (id, votes) => ({
    id,
    member_id: 'mem1',
    votes,
    views: votes,
    upload_date: NOW() - votes,
    labels: [],
    permission: { allowed: true, message: null },
});

const stubStrategy = ({ challenge = makeChallenge(), bankroll = FULL, library = [], overrides = {} } = {}) => ({
    getActiveChallenges: jest.fn().mockResolvedValue({ challenges: challenge ? [challenge] : [] }),
    getBankroll: jest.fn().mockResolvedValue(bankroll),
    getEligiblePhotos: jest.fn().mockResolvedValue(library),
    getImageData: jest.fn().mockResolvedValue(null),
    searchTagAutocomplete: jest.fn().mockResolvedValue([]),
    getCurrentMemberProfile: jest.fn().mockResolvedValue({ id: 'mem1', userName: 'u' }),
    keyUnlock: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
    swapPhoto: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
    exposureAutofill: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    __resetMemberIdCache();
});

describe('live re-check (shared by every spend)', () => {
    test('spends when the live state allows it', async () => {
        const strategy = stubStrategy();
        const result = await unlockBoostWithKey(555, 'tok', { strategy, logger });
        expect(result).toEqual({ ok: true, outcome: 'ok' });
        expect(strategy.keyUnlock).toHaveBeenCalledWith(555, 'tok');
    });

    test('challenge gone → not-available, nothing spent', async () => {
        const strategy = stubStrategy({ challenge: null });
        expect(await unlockBoostWithKey(555, 'tok', { strategy, logger })).toEqual({
            ok: false,
            outcome: 'not-available',
        });
        expect(strategy.keyUnlock).not.toHaveBeenCalled();
    });

    test('already unlocked (repeat request) → not-available, nothing spent', async () => {
        const challenge = makeChallenge();
        challenge.member.boost.state = 'AVAILABLE_KEY';
        const strategy = stubStrategy({ challenge });
        expect((await unlockBoostWithKey(555, 'tok', { strategy, logger })).outcome).toBe('not-available');
        expect(strategy.keyUnlock).not.toHaveBeenCalled();
    });

    test('unreadable bankroll → balance-unknown, nothing spent', async () => {
        const strategy = stubStrategy({ bankroll: null });
        expect((await fillExposure(555, 'tok', { strategy, logger })).outcome).toBe('balance-unknown');
        expect(strategy.exposureAutofill).not.toHaveBeenCalled();
    });

    test('stale balance: UI thought fills > 0, live balance is 0 → no-balance', async () => {
        const strategy = stubStrategy({ bankroll: { ...FULL, fills: 0 } });
        expect((await fillExposure(555, 'tok', { strategy, logger })).outcome).toBe('no-balance');
        expect(strategy.exposureAutofill).not.toHaveBeenCalled();
    });

    test('server rejection → api-failed', async () => {
        const strategy = stubStrategy({
            overrides: { keyUnlock: jest.fn().mockResolvedValue({ ok: false, raw: { success: false } }) },
        });
        expect((await unlockBoostWithKey(555, 'tok', { strategy, logger })).outcome).toBe('api-failed');
    });
});

describe('fillExposure', () => {
    test('sends the profile member id', async () => {
        const strategy = stubStrategy();
        await fillExposure(555, 'tok', { strategy, logger });
        expect(strategy.exposureAutofill).toHaveBeenCalledWith(555, 'mem1', 'tok');
    });

    test('falls back to the entry member_id when the profile lookup fails', async () => {
        const strategy = stubStrategy({ overrides: { getCurrentMemberProfile: jest.fn().mockResolvedValue(null) } });
        await fillExposure(555, 'tok', { strategy, logger });
        expect(strategy.exposureAutofill).toHaveBeenCalledWith(555, 'mem1', 'tok');
    });
});

describe('previewSwap', () => {
    test('picks the next-ranked alternative when the top-ranked photos are all excluded', async () => {
        // The three most popular photos are the entered one, one swapped out
        // before and the photo being replaced — ranking must reach past them.
        const library = [photo('entered', 900), photo('swapped-before', 800), photo('old', 700), photo('fresh', 10)];
        const strategy = stubStrategy({ library });
        const result = await previewSwap(555, 'old', 'tok', { strategy, logger, settings: null });
        expect(result).toEqual({ ok: true, outcome: 'ok', candidate: { id: 'fresh', member_id: 'mem1' } });
        expect(strategy.getEligiblePhotos).toHaveBeenCalledWith(555, 'tok', expect.objectContaining({ usage: 'swap' }));
    });

    test('no different photo → no-alternative', async () => {
        const strategy = stubStrategy({ library: [photo('entered', 5), photo('old', 4), photo('swapped-before', 3)] });
        expect((await previewSwap(555, 'old', 'tok', { strategy, logger, settings: null })).outcome).toBe(
            'no-alternative',
        );
    });

    test('entry no longer entered → not-available', async () => {
        const strategy = stubStrategy({ library: [photo('fresh', 1)] });
        expect((await previewSwap(555, 'gone', 'tok', { strategy, logger, settings: null })).outcome).toBe(
            'not-available',
        );
    });

    test('member_id falls back to the replaced entry when the library row lacks it', async () => {
        const row = { ...photo('fresh', 1) };
        delete row.member_id;
        const strategy = stubStrategy({ library: [row] });
        const result = await previewSwap(555, 'old', 'tok', { strategy, logger, settings: null });
        expect(result.candidate).toEqual({ id: 'fresh', member_id: 'mem1' });
    });
});

describe('swapEntry', () => {
    test('swaps the entry for the new photo', async () => {
        const strategy = stubStrategy();
        expect(await swapEntry(555, 'old', 'fresh', 'tok', { strategy, logger })).toEqual({ ok: true, outcome: 'ok' });
        expect(strategy.swapPhoto).toHaveBeenCalledWith(555, 'old', 'fresh', 'tok');
    });

    test.each(['old', 'entered', 'swapped-before'])('refuses %s as the replacement', async (newId) => {
        const strategy = stubStrategy();
        expect((await swapEntry(555, 'old', newId, 'tok', { strategy, logger })).outcome).toBe('stale-candidate');
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('photo no longer entered → not-available', async () => {
        const strategy = stubStrategy();
        expect((await swapEntry(555, 'gone', 'fresh', 'tok', { strategy, logger })).outcome).toBe('not-available');
    });
});

describe('swap back', () => {
    const { createMemoryLedger } = require('../../src/js/swapBackStore');
    const { swapBack } = require('../../src/js/services/currencyActions');

    // Slot now holds 'repl'; the boosted original 'orig' sits in the swap history.
    const swappedChallenge = () =>
        makeChallenge({
            member: {
                boost: { state: 'USED', timeout: null },
                ranking: {
                    exposure: { exposure_factor: 50 },
                    entries: [{ id: 'repl', member_id: 'mem1' }],
                    swaps: [{ id: 'orig' }],
                },
            },
        });

    test('swapEntry records a swapped-out boosted photo in the ledger', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries[1].boosted = true; // 'old' is boosted
        const strategy = stubStrategy({ challenge });
        const ledger = createMemoryLedger();
        await swapEntry(555, 'old', 'fresh', 'tok', { strategy, logger, ledger });
        expect(ledger.list(555)).toEqual([
            expect.objectContaining({ currentId: 'fresh', previousId: 'old', kind: 'boost' }),
        ]);
    });

    test('a rejected swap leaves the ledger alone', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries[1].boosted = true;
        const strategy = stubStrategy({
            challenge,
            overrides: { swapPhoto: jest.fn().mockResolvedValue({ ok: false, raw: null }) },
        });
        const ledger = createMemoryLedger();
        await swapEntry(555, 'old', 'fresh', 'tok', { strategy, logger, ledger });
        expect(ledger.list(555)).toEqual([]);
    });

    test('swaps the recorded original back and clears the record', async () => {
        const strategy = stubStrategy({ challenge: swappedChallenge() });
        const ledger = createMemoryLedger();
        ledger.onSwapped(555, { id: 'orig', member_id: 'mem1', boosted: true }, 'repl');
        expect(await swapBack(555, 'repl', 'tok', { strategy, logger, ledger })).toEqual({ ok: true, outcome: 'ok' });
        expect(strategy.swapPhoto).toHaveBeenCalledWith(555, 'repl', 'orig', 'tok');
        expect(ledger.list(555)).toEqual([]);
    });

    test('no record for that slot → not-available, nothing spent', async () => {
        const strategy = stubStrategy({ challenge: swappedChallenge() });
        expect((await swapBack(555, 'repl', 'tok', { strategy, logger, ledger: createMemoryLedger() })).outcome).toBe(
            'not-available',
        );
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('a record the live challenge no longer matches is dropped, nothing spent', async () => {
        const live = swappedChallenge();
        live.member.ranking.swaps = []; // the original is not in the swap history
        const strategy = stubStrategy({ challenge: live });
        const ledger = createMemoryLedger();
        ledger.onSwapped(555, { id: 'orig', member_id: 'mem1', boosted: true }, 'repl');
        expect((await swapBack(555, 'repl', 'tok', { strategy, logger, ledger })).outcome).toBe('not-available');
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
        expect(ledger.list(555)).toEqual([]);
    });

    test('out of swaps → no-balance, record kept', async () => {
        const strategy = stubStrategy({ challenge: swappedChallenge(), bankroll: { ...FULL, swaps: 0 } });
        const ledger = createMemoryLedger();
        ledger.onSwapped(555, { id: 'orig', member_id: 'mem1', boosted: true }, 'repl');
        expect((await swapBack(555, 'repl', 'tok', { strategy, logger, ledger })).outcome).toBe('no-balance');
        expect(ledger.list(555)).toHaveLength(1);
    });
});
