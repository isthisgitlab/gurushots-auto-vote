/**
 * Tests for ipc/currency.handlers —
 * key-unlock-boost, preview-swap-photo, swap-entry-photo, fill-exposure.
 * Covers: argument validation, auth guard, the main-side confirmation gate,
 * the cross-channel spend lock (incl. release after failure/throw), and the
 * swap preview binding (single-use, bounded, must match the commit).
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory');
jest.mock('../../src/js/services/auth');
jest.mock('../../src/js/services/currencyActions');

const apiFactory = require('../../src/js/apiFactory');
const auth = require('../../src/js/services/auth');
const currencyActions = require('../../src/js/services/currencyActions');
const { buildHandlers } = require('../../src/js/ipc/currency.handlers');

const OK = { ok: true, outcome: 'ok' };
let handlers;

beforeEach(() => {
    jest.clearAllMocks();
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    apiFactory.getApiStrategy = jest.fn().mockReturnValue({});
    currencyActions.unlockBoostWithKey.mockResolvedValue(OK);
    currencyActions.fillExposure.mockResolvedValue(OK);
    currencyActions.swapEntry.mockResolvedValue(OK);
    currencyActions.previewSwap.mockResolvedValue({ ...OK, candidate: { id: 'new1', member_id: 'm' } });
    handlers = buildHandlers();
});

describe.each([
    ['key-unlock-boost', (h, confirmed) => h['key-unlock-boost'](null, 10, confirmed), 'unlockBoostWithKey'],
    ['fill-exposure', (h, confirmed) => h['fill-exposure'](null, 10, confirmed), 'fillExposure'],
])('%s', (_, call, serviceFn) => {
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
        expect((await handlers['key-unlock-boost'](null, bad, true)).outcome).toBe('invalid-args');
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('swap requires string ids for the image and replacement', async () => {
        expect((await handlers['swap-entry-photo'](null, 1, { x: 1 }, 'n', true)).outcome).toBe('invalid-args');
        expect((await handlers['preview-swap-photo'](null, 1, null)).outcome).toBe('invalid-args');
    });
});

describe('spend lock', () => {
    test('a second spend while one is in flight gets busy, across channels', async () => {
        let release;
        currencyActions.unlockBoostWithKey.mockReturnValue(new Promise((r) => (release = r)));
        const first = handlers['key-unlock-boost'](null, 10, true);
        expect((await handlers['fill-exposure'](null, 11, true)).outcome).toBe('busy');
        release(OK);
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
        expect((await handlers['swap-entry-photo'](null, 10, 'old', 'new1')).outcome).toBe('needs-confirm');
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

describe('swap back channels', () => {
    beforeEach(() => {
        currencyActions.swapBack.mockResolvedValue(OK);
        apiFactory.getApiStrategy = jest.fn().mockReturnValue({ getStrategyType: () => 'MockAPI' });
    });

    test('get-swap-backs lists the ledger records without spending', async () => {
        expect(await handlers['get-swap-backs'](null, 10)).toEqual({ success: true, items: [] });
    });

    test('get-swap-backs validates the challenge id', async () => {
        expect((await handlers['get-swap-backs'](null, null)).outcome).toBe('invalid-args');
    });

    test('a successful swap passes the ledger along so it can record a boosted original', async () => {
        await handlers['preview-swap-photo'](null, 10, 'old');
        await handlers['swap-entry-photo'](null, 10, 'old', 'new1', true);
        expect(currencyActions.swapEntry.mock.calls[0][4].ledger).toEqual(
            expect.objectContaining({ list: expect.any(Function), onSwapped: expect.any(Function) }),
        );
    });

    test('swap-back-entry-photo requires confirmation', async () => {
        expect((await handlers['swap-back-entry-photo'](null, 10, 'repl')).outcome).toBe('needs-confirm');
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
        const { swapBackLedger } = require('../../src/js/swapBackStore');
        await handlers['swap-back-entry-photo'](null, 10, 'repl', true);
        expect(currencyActions.swapBack.mock.calls[0][3].ledger).not.toBe(swapBackLedger);
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
        currencyActions.previewSwap.mockResolvedValueOnce({ ok: true, outcome: 'ok' });
        expect((await handlers['preview-swap-photo'](null, 13, 'old')).success).toBe(false);
    });
});

describe('get-swap-backs listing', () => {
    beforeEach(() => {
        apiFactory.getApiStrategy = jest.fn().mockReturnValue({ getStrategyType: () => 'MockAPI' });
    });

    test('lists only the public fields of a recorded boosted original', async () => {
        currencyActions.swapEntry.mockImplementationOnce(async (challengeId, imageId, newImageId, _token, deps) => {
            deps.ledger.onSwapped(challengeId, { id: imageId, boosted: true, member_id: 'mem' }, newImageId);
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
        const { register } = require('../../src/js/ipc/currency.handlers');
        const channels = new Map();
        register({ handle: (channel, impl) => channels.set(channel, impl) });
        expect([...channels.keys()].sort()).toEqual(Object.keys(handlers).sort());
        expect((await channels.get('fill-exposure')(undefined, 10, false)).outcome).toBe('needs-confirm');
    });
});
