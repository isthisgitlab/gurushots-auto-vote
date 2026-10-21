/**
 * Tests for ipc/currency.handlers —
 * key-unlock-boost, preview-swap-photo, swap-entry-photo, fill-exposure.
 * Covers: argument validation, auth guard, the main-side confirmation gate,
 * the cross-channel spend lock (incl. release after failure/throw), and the
 * swap preview binding (single-use, bounded, must match the commit).
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/services/currencyActions');

import type { IpcMain } from 'electron';
import { invalid } from '../helpers/invalid';
import { logCategories } from '../helpers/logCategories';

import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import currencyActionsModule = require('../../src/ts/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as currency_handlersModule from '../../src/ts/ipc/currency.handlers';
import type * as swapBackStoreModule from '../../src/ts/swapBackStore';
import type * as libraryCacheModule from '../../src/ts/services/libraryCache';
const { buildHandlers } = require('../../src/ts/ipc/currency.handlers') as typeof currency_handlersModule;
const { writeListing, readFresh, clearLibraryCache } =
    require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;

const OK = { ok: true, outcome: 'ok' };
// The handlers as the tests read them: every result is an envelope whose `outcome` the
// auth-guard response leaves out.
type Envelope = { success: boolean; outcome?: string };
type Handlers = {
    [K in keyof ReturnType<typeof buildHandlers>]: (
        ...args: Parameters<ReturnType<typeof buildHandlers>[K]>
    ) => Promise<Envelope>;
};
// A handler called without its trailing optional `confirmed` argument.
type OmitLast<F> = F extends (...args: [...infer A, never]) => infer R ? (...args: A) => R : never;
let handlers: Handlers;

beforeEach(() => {
    jest.clearAllMocks();
    clearLibraryCache();
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    apiFactory.getApiStrategy = jest.fn().mockReturnValue({});
    // The spend lock is real (the handlers share it with the automatic runners);
    // only the spend services are mocked.
    currencyActions.withSpendLock.mockImplementation(
        jest.requireActual<typeof import('../../src/ts/services/currencyActions')>(
            '../../src/ts/services/currencyActions',
        ).withSpendLock,
    );
    currencyActions.unlockBoostWithKey.mockResolvedValue(OK);
    currencyActions.fillExposure.mockResolvedValue(OK);
    currencyActions.swapEntry.mockResolvedValue(OK);
    currencyActions.previewSwap.mockResolvedValue({ ...OK, candidate: { id: 'new1', member_id: 'm' } });
    handlers = buildHandlers();
});

describe.each([
    [
        'key-unlock-boost',
        (h: Handlers, confirmed: unknown) => h['key-unlock-boost'](null, 10, invalid(confirmed)),
        'unlockBoostWithKey',
    ],
    [
        'fill-exposure',
        (h: Handlers, confirmed: unknown) => h['fill-exposure'](null, 10, invalid(confirmed)),
        'fillExposure',
    ],
] as const)('%s', (_, call, serviceFn) => {
    test('spends with confirmed === true', async () => {
        expect(await call(handlers, true)).toEqual({ success: true, outcome: 'ok' });
        expect(currencyActions[serviceFn]).toHaveBeenCalledWith(10, 'tok', expect.any(Object));
    });

    test.each([undefined, false, 'true', 1])('confirmed=%p → needs-confirm, nothing spent', async (confirmed) => {
        expect((await call(handlers, confirmed)).outcome).toBe('needs-confirm');
        expect(currencyActions[serviceFn]).not.toHaveBeenCalled();
    });

    test('auth failure returns the guard response', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'no token' } });
        expect(await call(handlers, true)).toEqual({ success: false, error: 'no token' });
        expect(currencyActions[serviceFn]).not.toHaveBeenCalled();
    });

    test('service outcome is passed through on failure', async () => {
        currencyActions[serviceFn].mockResolvedValue({ ok: false, outcome: 'no-balance' });
        expect(await call(handlers, true)).toEqual({ success: false, outcome: 'no-balance', error: 'no-balance' });
    });
});

describe('argument validation', () => {
    test.each([null, undefined, '', '   ', {}, []])('challengeId %p → invalid-args', async (bad) => {
        expect((await handlers['key-unlock-boost'](null, invalid(bad), true)).outcome).toBe('invalid-args');
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('swap requires string ids for the image and replacement', async () => {
        expect((await handlers['swap-entry-photo'](null, 1, invalid({ x: 1 }), 'n', true)).outcome).toBe(
            'invalid-args',
        );
        expect((await handlers['preview-swap-photo'](null, 1, invalid(null))).outcome).toBe('invalid-args');
    });
});

describe('spend lock', () => {
    test('a second spend while one is in flight gets busy, across channels', async () => {
        let release:
            | ((value: Awaited<ReturnType<typeof currencyActionsModule.unlockBoostWithKey>>) => void)
            | undefined;
        currencyActions.unlockBoostWithKey.mockReturnValue(new Promise((r) => (release = r)));
        const first = handlers['key-unlock-boost'](null, 10, true);
        expect((await handlers['fill-exposure'](null, 11, true)).outcome).toBe('busy');
        release!(OK);
        expect((await first).success).toBe(true);
    });

    test('released after a service failure', async () => {
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
        await handlers['fill-exposure'](null, 10, true);
        expect((await handlers['fill-exposure'](null, 10, true)).success).toBe(true);
    });

    test('released after a thrown error (never wedged)', async () => {
        currencyActions.fillExposure.mockRejectedValueOnce(new Error('boom'));
        expect((await handlers['fill-exposure'](null, 10, true)).outcome).toBe('api-failed');
        expect((await handlers['fill-exposure'](null, 10, true)).success).toBe(true);
    });
});

describe('swap preview binding', () => {
    const preview = () => handlers['preview-swap-photo'](null, 10, 'old');

    test('preview returns the candidate without spending', async () => {
        expect(await preview()).toEqual({ success: true, outcome: 'ok', candidate: { id: 'new1', member_id: 'm' } });
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
    });

    test('commit with the previewed candidate swaps', async () => {
        await preview();
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true)).success).toBe(true);
        expect(currencyActions.swapEntry).toHaveBeenCalledWith(10, 'old', 'new1', 'tok', expect.any(Object));
    });

    test('commit without a preview → stale-candidate', async () => {
        expect((await handlers['swap-entry-photo'](null, 10, 'other', 'new1', true)).outcome).toBe('stale-candidate');
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
    });

    test('commit naming a different photo than previewed → stale-candidate', async () => {
        await preview();
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'sneaky', true)).outcome).toBe('stale-candidate');
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
    });

    test('a preview is single-use', async () => {
        await preview();
        await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true);
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true)).outcome).toBe('stale-candidate');
        expect(currencyActions.swapEntry).toHaveBeenCalledTimes(1);
    });

    test('an expired preview → stale-candidate', async () => {
        const realNow = Date.now;
        try {
            await preview();
            Date.now = () => realNow() + 5 * 60 * 1000 + 1;
            expect((await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true)).outcome).toBe('stale-candidate');
        } finally {
            Date.now = realNow;
        }
    });

    test('commit without confirmation does not consume the preview', async () => {
        await preview();
        expect(
            (
                await invalid<OmitLast<Handlers['swap-entry-photo']>>(handlers['swap-entry-photo'])(
                    null,
                    10,
                    'old',
                    'new1',
                )
            ).outcome,
        ).toBe('needs-confirm');
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true)).success).toBe(true);
    });

    test('the preview store is bounded — the oldest preview is evicted past 32', async () => {
        for (let i = 0; i < 33; i++) {
            await handlers['preview-swap-photo'](null, 10, `img${i}`);
        }
        expect((await handlers['swap-entry-photo'](null, 10, 'img0', 'new1', true)).outcome).toBe('stale-candidate');
        expect((await handlers['swap-entry-photo'](null, 10, 'img32', 'new1', true)).success).toBe(true);
    });

    test('a failed preview is not remembered', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ok: false, outcome: 'no-alternative' });
        expect((await handlers['preview-swap-photo'](null, 10, 'x')).outcome).toBe('no-alternative');
        expect((await handlers['swap-entry-photo'](null, 10, 'x', 'new1', true)).outcome).toBe('stale-candidate');
    });
});

describe('swap preview of a chosen photo', () => {
    const chosen = (chosenId: unknown) => handlers['preview-swap-photo'](null, 10, 'old', invalid(chosenId));

    test.each([[undefined], [null]])('%s means "not given": the ranked path', async (chosenId) => {
        expect((await chosen(chosenId)).success).toBe(true);
        expect(currencyActions.previewSwap).toHaveBeenCalledWith(10, 'old', 'tok', expect.any(Object), {});
    });

    test('a chosen id goes to the service, as a string', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ...OK, candidate: { id: 'pick-1', member_id: 'm' } });
        expect(await chosen('pick-1')).toEqual({
            success: true,
            outcome: 'ok',
            candidate: { id: 'pick-1', member_id: 'm' },
        });
        expect(currencyActions.previewSwap).toHaveBeenCalledWith(10, 'old', 'tok', expect.any(Object), {
            chosenId: 'pick-1',
        });
    });

    test('a numeric chosen id is normalised to a string', async () => {
        await chosen(4242);
        expect(currencyActions.previewSwap.mock.calls[0][4]).toEqual({ chosenId: '4242' });
    });

    test.each([['has space'], ['a/b'], [''], ['x'.repeat(65)], [{}], [true], [Number.NaN]])(
        'a chosen id that is not a library id (%p) → invalid-args, nothing previewed',
        async (chosenId) => {
            expect((await chosen(chosenId)).outcome).toBe('invalid-args');
            expect(currencyActions.previewSwap).not.toHaveBeenCalled();
        },
    );

    test('the chosen id is logged only when given', async () => {
        await chosen(null);
        await chosen('pick-1');
        const base = '🔄 Swap preview request: Challenge=10, Image=old';
        expect(logCategories('info', base, null)).toEqual(['currency']);
        expect(logCategories('info', `${base}, chosen=pick-1`, null)).toEqual(['currency']);
    });

    test('the commit takes exactly the remembered chosen id, once', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ...OK, candidate: { id: 'pick-1', member_id: 'm' } });
        await chosen('pick-1');
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'other', true)).outcome).toBe('stale-candidate');
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        // The refused attempt consumed it.
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'pick-1', true)).outcome).toBe('stale-candidate');
    });

    test('the remembered chosen id is accepted at the commit', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ...OK, candidate: { id: 'pick-1', member_id: 'm' } });
        await chosen('pick-1');
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'pick-1', true)).success).toBe(true);
        expect(currencyActions.swapEntry).toHaveBeenCalledWith(10, 'old', 'pick-1', 'tok', expect.any(Object));
    });

    test('a later preview for the same entry replaces the earlier one', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ...OK, candidate: { id: 'pick-1', member_id: 'm' } });
        await chosen('pick-1');
        await handlers['preview-swap-photo'](null, 10, 'old');
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'pick-1', true)).outcome).toBe('stale-candidate');
    });

    test('an already-entered refusal is passed on and not remembered', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ok: false, outcome: 'already-entered' });
        expect((await chosen('pick-1')).outcome).toBe('already-entered');
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'pick-1', true)).outcome).toBe('stale-candidate');
    });
});

describe('swap back channels', () => {
    beforeEach(() => {
        currencyActions.swapBack.mockResolvedValue(OK);
        apiFactory.getApiStrategy = jest.fn().mockReturnValue({ getStrategyType: () => 'MockAPI' });
    });

    test('get-swap-backs lists the ledger records without spending', async () => {
        expect(await handlers['get-swap-backs'](null, 10)).toEqual({ success: true, items: [] });
    });

    test('get-swap-backs validates the challenge id', async () => {
        expect((await handlers['get-swap-backs'](null, invalid(null))).outcome).toBe('invalid-args');
    });

    test('a successful swap passes the ledger along so it can record a boosted original', async () => {
        await handlers['preview-swap-photo'](null, 10, 'old');
        await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true);
        expect(currencyActions.swapEntry.mock.calls[0][4].ledger).toEqual(
            expect.objectContaining({ list: expect.any(Function), onSwapped: expect.any(Function) }),
        );
    });

    test('swap-back-entry-photo requires confirmation', async () => {
        expect(
            (
                await invalid<OmitLast<Handlers['swap-back-entry-photo']>>(handlers['swap-back-entry-photo'])(
                    null,
                    10,
                    'repl',
                )
            ).outcome,
        ).toBe('needs-confirm');
        expect(currencyActions.swapBack).not.toHaveBeenCalled();
    });

    test('swap-back-entry-photo spends through the service with the ledger', async () => {
        expect((await handlers['swap-back-entry-photo'](null, 10, 'repl', true)).success).toBe(true);
        expect(currencyActions.swapBack).toHaveBeenCalledWith(
            10,
            'repl',
            'tok',
            expect.objectContaining({ ledger: expect.any(Object) }),
        );
    });

    test('mock mode uses an in-memory ledger, never the real one', async () => {
        const { swapBackLedger } = require('../../src/ts/swapBackStore') as typeof swapBackStoreModule;
        await handlers['swap-back-entry-photo'](null, 10, 'repl', true);
        expect(currencyActions.swapBack.mock.calls[0][3].ledger).not.toBe(swapBackLedger);
    });
});

describe('the library listing a swap outdates', () => {
    const keepListings = () => {
        const listing = {
            photos: [],
            memberId: 'm',
            wonIds: [],
            wonCount: 0,
            truncated: false,
            nextStart: 0,
            allowedKnown: true,
            readAtMs: Date.now(),
        };
        writeListing('tok', '10', listing);
        writeListing('tok', '11', listing);
    };
    const kept = (id: string) => readFresh('tok', id) !== null;
    const swap = async () => {
        await handlers['preview-swap-photo'](null, 10, 'old');
        return handlers['swap-entry-photo'](null, 10, 'old', 'new1', true);
    };
    const swapBack = () => handlers['swap-back-entry-photo'](null, 10, 'repl', true);

    test.each([
        ['swap-entry-photo', swap, () => currencyActions.swapEntry],
        ['swap-back-entry-photo', swapBack, () => currencyActions.swapBack],
    ])('%s drops that challenge’s listing, whatever the spend came to', async (_name, act, service) => {
        for (const outcome of [
            () => Promise.resolve(OK),
            () => Promise.resolve({ ok: false, outcome: 'api-failed' }),
            () => Promise.reject(new Error('boom')),
        ]) {
            keepListings();
            service().mockImplementationOnce(outcome);
            await act();
            expect(kept('10')).toBe(false);
            expect(kept('11')).toBe(true);
        }
    });

    test('nothing is dropped when nothing was spent: unconfirmed, a stale preview, a busy lock, invalid arguments, no token', async () => {
        keepListings();
        await handlers['swap-entry-photo'](null, 10, 'old', 'new1', false);
        await handlers['swap-entry-photo'](null, 10, 'old', 'never-previewed', true);
        await invalid<OmitLast<Handlers['swap-back-entry-photo']>>(handlers['swap-back-entry-photo'])(null, 10, 'repl');
        await handlers['swap-back-entry-photo'](null, invalid<number>({}), 'repl', true);
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'No authentication token found' } });
        await handlers['swap-back-entry-photo'](null, 10, 'repl', true);
        expect([kept('10'), kept('11')]).toEqual([true, true]);
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        expect(currencyActions.swapBack).not.toHaveBeenCalled();
    });

    test('the other spends leave the listing alone: a key unlock and an exposure fill change no photo', async () => {
        keepListings();
        await handlers['key-unlock-boost'](null, 10, true);
        await handlers['fill-exposure'](null, 10, true);
        expect([kept('10'), kept('11')]).toEqual([true, true]);
    });
});

describe('preview-swap-photo edge cases', () => {
    test('expired previews are pruned when a new preview is remembered', async () => {
        const realNow = Date.now;
        try {
            await handlers['preview-swap-photo'](null, 11, 'pruned');
            // Remembering a new preview after the TTL sweeps the expired one out.
            Date.now = () => realNow() + 5 * 60 * 1000 + 1;
            await handlers['preview-swap-photo'](null, 11, 'fresh');
        } finally {
            Date.now = realNow;
        }
        // Back at real time the pruned entry would still be within its TTL —
        // stale-candidate here proves it was deleted, not merely expired.
        expect((await handlers['swap-entry-photo'](null, 11, 'pruned', 'new1', true)).outcome).toBe('stale-candidate');
        expect((await handlers['swap-entry-photo'](null, 11, 'fresh', 'new1', true)).success).toBe(true);
    });

    test('auth failure returns the guard response without previewing', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'no token' } });
        expect(await handlers['preview-swap-photo'](null, 10, 'old')).toEqual({ success: false, error: 'no token' });
        expect(currencyActions.previewSwap).not.toHaveBeenCalled();
    });

    test('a thrown preview error maps to api-failed and is not remembered', async () => {
        currencyActions.previewSwap.mockRejectedValueOnce(new Error('network'));
        expect(await handlers['preview-swap-photo'](null, 12, 'old')).toEqual({
            success: false,
            outcome: 'api-failed',
            error: 'api-failed',
        });
        expect((await handlers['swap-entry-photo'](null, 12, 'old', 'new1', true)).outcome).toBe('stale-candidate');
    });

    test('a preview without a candidate is a failure', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce(invalid({ ok: true, outcome: 'ok' }));
        expect((await handlers['preview-swap-photo'](null, 13, 'old')).success).toBe(false);
    });
});

describe('get-swap-backs listing', () => {
    beforeEach(() => {
        apiFactory.getApiStrategy = jest.fn().mockReturnValue({ getStrategyType: () => 'MockAPI' });
    });

    test('lists only the public fields of a recorded boosted original', async () => {
        currencyActions.swapEntry.mockImplementationOnce(async (challengeId, imageId, newImageId, _token, deps) => {
            deps.ledger!.onSwapped(challengeId, { id: imageId, boosted: true, member_id: 'mem' }, newImageId);
            return OK;
        });
        await handlers['preview-swap-photo'](null, 77, 'orig');
        await handlers['swap-entry-photo'](null, 77, 'orig', 'new1', true);

        expect(await handlers['get-swap-backs'](null, 77)).toEqual({
            success: true,
            items: [{ currentId: 'new1', previousId: 'orig', previousMemberId: 'mem', kind: 'boost' }],
        });
    });

    test('returns an empty api-failed envelope when the strategy lookup throws', async () => {
        apiFactory.getApiStrategy = jest.fn(() => {
            throw new Error('settings corrupt');
        });
        expect(await handlers['get-swap-backs'](null, 77)).toEqual({
            success: false,
            items: [],
            error: 'api-failed',
        });
    });
});

describe('register', () => {
    test('registers every currency channel on ipcMain', async () => {
        const { register } = require('../../src/ts/ipc/currency.handlers') as typeof currency_handlersModule;
        const channels = new Map<string, Parameters<IpcMain['handle']>[1]>();
        register(
            invalid({
                handle: (channel: string, impl: Parameters<IpcMain['handle']>[1]) => channels.set(channel, impl),
            }),
        );
        expect([...channels.keys()].sort()).toEqual(Object.keys(handlers).sort());
        expect(((await channels.get('fill-exposure')!(invalid(undefined), 10, false)) as Envelope).outcome).toBe(
            'needs-confirm',
        );
    });
});
