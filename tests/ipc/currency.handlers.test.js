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
