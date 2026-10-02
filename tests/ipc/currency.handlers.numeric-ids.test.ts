/**
 * ipc/currency.handlers with the REAL currencyActions service and numeric image
 * ids. isIdArg admits finite numbers, so the swap handlers can receive an image
 * id as a number even though their service signatures say string. The handler
 * normalises it once, so preview and swap still find the entry, and the
 * stale-candidate guards still refuse a swap that must not happen. The
 * swap-back handlers are validated and normalised the same way.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');

import { invalid } from '../helpers/invalid';

import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as currency_handlersModule from '../../src/ts/ipc/currency.handlers';
import type * as swapBackStoreModule from '../../src/ts/swapBackStore';
import type { Challenge } from '../../src/ts/types/gurushots';
const { __resetMemberIdCache } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { mockSwapBackLedger } = require('../../src/ts/swapBackStore') as typeof swapBackStoreModule;
const { buildHandlers } = require('../../src/ts/ipc/currency.handlers') as typeof currency_handlersModule;

const NOW = () => Math.floor(Date.now() / 1000);
const FULL = { keys: 2, swaps: 2, fills: 2, coins: 0 };

type Entry = { id: number; member_id: string };

// A partial challenge: the swap checks read only these fields.
const makeChallenge = (entries: Entry[], swaps: Array<{ id: number }> = []) =>
    invalid<Challenge>({
        id: 555,
        title: 'Anything Goes',
        start_time: NOW() - 3600,
        close_time: NOW() + 3600,
        swap_enable: true,
        swap_locked: false,
        member: { ranking: { exposure: { exposure_factor: 50 }, entries, swaps } },
    });

const photo = (id: number, votes: number) => ({
    id: String(id),
    member_id: 'mem1',
    votes,
    views: votes,
    upload_date: NOW() - votes,
    labels: [],
    permission: { allowed: true, message: null },
});

const OLD = { id: 111, member_id: 'mem1' };
const OTHER = { id: 222, member_id: 'mem1' };

let live: Challenge;
const strategy = {
    getActiveChallenges: jest.fn(async () => ({ challenges: [live] })),
    getBankroll: jest.fn().mockResolvedValue(FULL),
    getEligiblePhotos: jest.fn().mockResolvedValue([photo(222, 900), photo(111, 700), photo(333, 10)]),
    getImageData: jest.fn().mockResolvedValue(null),
    searchTagAutocomplete: jest.fn().mockResolvedValue([]),
    getCurrentMemberProfile: jest.fn().mockResolvedValue({ id: 'mem1', userName: 'u' }),
    swapPhoto: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
    getStrategyType: () => 'MockAPI',
};

let handlers: ReturnType<typeof buildHandlers>;

beforeEach(() => {
    jest.clearAllMocks();
    __resetMemberIdCache();
    live = makeChallenge([OLD, OTHER]);
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(invalid<apiFactoryModule.ApiStrategy>(strategy));
    handlers = buildHandlers();
});

describe('numeric image ids', () => {
    test('preview finds the entry and returns the candidate', async () => {
        const result = await handlers['preview-swap-photo'](null, 555, 111);
        expect(result).toEqual({ success: true, outcome: 'ok', candidate: { id: '333', member_id: 'mem1' } });
    });

    test('a previewed numeric candidate swaps through to the API as strings', async () => {
        await handlers['preview-swap-photo'](null, 555, 111);
        const result = await handlers['swap-entry-photo'](null, 555, 111, 333, true);
        expect(result).toEqual({ success: true, outcome: 'ok' });
        expect(strategy.swapPhoto).toHaveBeenCalledWith(555, '111', '333', 'tok');
    });

    test('a numeric replacement equal to the replaced image is stale, nothing spent', async () => {
        await handlers['preview-swap-photo'](null, 555, 111);
        const result = await handlers['swap-entry-photo'](null, 555, 111, 111, true);
        expect(result).toEqual({ success: false, outcome: 'stale-candidate', error: 'stale-candidate' });
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('a candidate that became an entry after the preview is stale, nothing spent', async () => {
        await handlers['preview-swap-photo'](null, 555, 111);
        live = makeChallenge([OLD, OTHER, { id: 333, member_id: 'mem1' }]);
        const result = await handlers['swap-entry-photo'](null, 555, 111, 333, true);
        expect(result).toEqual({ success: false, outcome: 'stale-candidate', error: 'stale-candidate' });
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('an image that is not entered is not available, nothing spent', async () => {
        const result = await handlers['preview-swap-photo'](null, 555, 999);
        expect(result).toEqual({ success: false, outcome: 'not-available', error: 'not-available' });
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });
});

describe('numeric ids on the swap-back handlers', () => {
    // 111 was swapped out while boosted; 333 now holds its slot.
    const seedRecord = () => {
        mockSwapBackLedger.onSwapped(555, { id: 111, boosted: true, member_id: 'mem1' }, 333);
        live = makeChallenge([OTHER, { id: 333, member_id: 'mem1' }], [{ id: 111 }]);
    };

    afterEach(() => {
        mockSwapBackLedger.remove(555, '333');
    });

    test('get-swap-backs lists the records of a numeric challenge id with string ids', async () => {
        seedRecord();
        expect(await handlers['get-swap-backs'](null, 555)).toEqual({
            success: true,
            items: [{ currentId: '333', previousId: '111', previousMemberId: 'mem1', kind: 'boost' }],
        });
    });

    test('get-swap-backs refuses a non-finite id', async () => {
        expect(await handlers['get-swap-backs'](null, NaN)).toEqual({
            success: false,
            outcome: 'invalid-args',
            error: 'invalid-args',
        });
    });

    test('a numeric slot id swaps back through to the API as strings and clears the record', async () => {
        seedRecord();
        const result = await handlers['swap-back-entry-photo'](null, 555, 333, true);
        expect(result).toEqual({ success: true, outcome: 'ok' });
        expect(strategy.swapPhoto).toHaveBeenCalledWith(555, '333', '111', 'tok');
        expect(mockSwapBackLedger.list(555)).toEqual([]);
    });

    test('a numeric slot id with no record is not available, nothing spent', async () => {
        const result = await handlers['swap-back-entry-photo'](null, 555, 333, true);
        expect(result).toEqual({ success: false, outcome: 'not-available', error: 'not-available' });
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('swap-back refuses a non-finite slot id before spending', async () => {
        seedRecord();
        const result = await handlers['swap-back-entry-photo'](null, 555, Infinity, true);
        expect(result).toEqual({ success: false, outcome: 'invalid-args', error: 'invalid-args' });
        expect(strategy.swapPhoto).not.toHaveBeenCalled();
    });
});
