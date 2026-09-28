/**
 * Edge-case tests for the CLI one-shot action and currency commands
 * (commands/actions.ts): fallback messages when a handler returns no error
 * text or throws a non-Error, the lookup bail-outs, swap flag parsing and the
 * cost line when the balance can't be read. Complements cli-actions.test.ts
 * (happy paths) and cli-currency.test.ts (the --yes confirmation gate).
 */

jest.mock('../../src/js/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success') };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});

jest.mock('../../src/js/apiFactory', () => {
    const mw = { isAuthenticated: jest.fn(() => true), getActiveChallenges: jest.fn(), applyBoost: jest.fn() };
    return { __mw: mw, getMiddleware: jest.fn(() => mw) };
});

jest.mock('../../src/js/ipc/actions.handlers', () => {
    const handlers = {
        'apply-boost-to-entry': jest.fn(),
        'play-auto-turbo': jest.fn(),
        'fill-challenge-now': jest.fn(),
        'get-bankroll': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

jest.mock('../../src/js/ipc/currency.handlers', () => {
    const handlers = {
        'key-unlock-boost': jest.fn(),
        'preview-swap-photo': jest.fn(),
        'swap-entry-photo': jest.fn(),
        'get-swap-backs': jest.fn(),
        'swap-back-entry-photo': jest.fn(),
        'fill-exposure': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

import loggerModule = require('../../src/js/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
const { __mw: mw } = jest.mocked(
    require('../../src/js/apiFactory') as typeof apiFactoryModule & {
        __mw: Pick<Middleware, 'isAuthenticated' | 'getActiveChallenges' | 'applyBoost'>;
    },
);
const h: jest.Mocked<EdgeHandlers> = {
    ...invalid<{ __handlers: jest.Mocked<Pick<ActionHandlers, ActionChannel>> }>(
        require('../../src/js/ipc/actions.handlers'),
    ).__handlers,
    ...invalid<{ __handlers: jest.Mocked<CurrencyHandlers> }>(require('../../src/js/ipc/currency.handlers')).__handlers,
};
import actions = require('../../src/js/cli/commands/actions');
import type * as apiFactoryModule from '../../src/js/apiFactory';
import type * as actionsHandlersModule from '../../src/js/ipc/actions.handlers';
import type * as currencyHandlersModule from '../../src/js/ipc/currency.handlers';
import { invalid } from '../helpers/invalid';

type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
type ActionHandlers = ReturnType<typeof actionsHandlersModule.buildHandlers>;
type CurrencyHandlers = ReturnType<typeof currencyHandlersModule.buildHandlers>;
/** The action channels the mock factory above provides. */
type ActionChannel = 'apply-boost-to-entry' | 'play-auto-turbo' | 'fill-challenge-now' | 'get-bankroll';
type EdgeHandlers = Pick<ActionHandlers, ActionChannel> & CurrencyHandlers;

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));

beforeEach(() => {
    logger.__calls.length = 0;
    // mockReset so queued *Once values never leak between tests under --randomize.
    Object.values(h).forEach((m) => m.mockReset());
    mw.applyBoost.mockReset();
    mw.isAuthenticated.mockReturnValue(true);
    mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
    h['get-bankroll'].mockResolvedValue(invalid({ success: true, keys: 0, swaps: 3, fills: 1 }));
    h['preview-swap-photo'].mockResolvedValue(invalid({ success: true, candidate: { id: 'new9' } }));
    h['get-swap-backs'].mockResolvedValue(
        invalid({
            success: true,
            items: [{ currentId: 'repl', previousId: 'orig', kind: 'turbo' }],
        }),
    );
});

describe('challenge lookup', () => {
    test('a thrown non-Error fetch failure is stringified', async () => {
        mw.getActiveChallenges.mockRejectedValue('offline');
        await actions.boostChallenge('111');
        expect(msgs('error')).toEqual(['Failed to fetch challenges: offline']);
    });

    test('a response without a challenges list reports not found', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid(null));
        await actions.boostChallenge('111');
        expect(msgs('error')).toEqual(['Challenge 111 not found among active challenges']);
    });

    test.each<['turboChallenge' | 'fillChallenge' | 'unlockBoostCmd' | 'fillExposureCmd', keyof EdgeHandlers]>([
        ['turboChallenge', 'play-auto-turbo'],
        ['fillChallenge', 'fill-challenge-now'],
        ['unlockBoostCmd', 'key-unlock-boost'],
        ['fillExposureCmd', 'fill-exposure'],
    ])('%s bails out when the challenge is unknown', async (fn, channel) => {
        await actions[fn]('999');
        expect(h[channel]).not.toHaveBeenCalled();
    });

    test('swap bails out (undefined, not a usage error) when the challenge is unknown', async () => {
        await expect(actions.swapCmd('999', { imageId: 'a' })).resolves.toBe(true);
        expect(h['preview-swap-photo']).not.toHaveBeenCalled();
    });

    test('swap-back returns true (not a usage error) when the challenge is unknown', async () => {
        await expect(actions.swapBackCmd('999', { imageId: 'a' })).resolves.toBe(true);
        expect(h['get-swap-backs']).not.toHaveBeenCalled();
    });
});

describe('boost / turbo / fill fallbacks', () => {
    test('boost --image failure with no error text uses the default message', async () => {
        h['apply-boost-to-entry'].mockResolvedValue(invalid(null));
        await actions.boostChallenge('111', { imageId: 'img' });
        expect(msgs('error')).toEqual(['Failed to apply boost']);
    });

    test('boost: a thrown non-Error is stringified', async () => {
        mw.applyBoost.mockRejectedValue('nope');
        await actions.boostChallenge('111');
        expect(msgs('error')).toEqual(['Failed to apply boost: nope']);
    });

    test('turbo failure with no error text uses the default message', async () => {
        h['play-auto-turbo'].mockResolvedValue(invalid(undefined));
        await actions.turboChallenge('111');
        expect(msgs('error')).toEqual(['Turbo not earned']);
    });

    test('turbo: a thrown non-Error is stringified', async () => {
        h['play-auto-turbo'].mockRejectedValue('crash');
        await actions.turboChallenge('111');
        expect(msgs('error')).toEqual(['Failed to play turbo: crash']);
    });

    test('fill without opts uses mode "one" and reports the handler message and counts', async () => {
        h['fill-challenge-now'].mockResolvedValue(
            invalid({ success: true, message: 'Done', submitted: 2, skipped: 1 }),
        );
        await actions.fillChallenge('111');
        expect(h['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'one');
        expect(msgs('success')).toEqual(['Done (submitted 2, skipped 1)']);
    });

    test('fill success without message/counts falls back to defaults', async () => {
        h['fill-challenge-now'].mockResolvedValue(invalid({ success: true }));
        await actions.fillChallenge('111', { all: true });
        expect(msgs('success')).toEqual(['Submitted photos to "Sunset" (submitted 0, skipped 0)']);
    });

    test('fill failure with no error text uses the default message', async () => {
        h['fill-challenge-now'].mockResolvedValue(invalid(null));
        await actions.fillChallenge('111');
        expect(msgs('error')).toEqual(['Failed to submit photos']);
    });

    test('fill: a thrown non-Error is stringified', async () => {
        h['fill-challenge-now'].mockRejectedValue('disk');
        await actions.fillChallenge('111');
        expect(msgs('error')).toEqual(['Failed to submit photos: disk']);
    });
});

describe('currency spends', () => {
    test('the cost line says so when the balance cannot be read', async () => {
        h['get-bankroll'].mockResolvedValue(invalid({ success: false }));
        await actions.unlockBoostCmd('111');
        expect(msgs('info')).toContain('Cost: 1 key (balance could not be read).');
    });

    test('the projected balance never goes below zero', async () => {
        await actions.unlockBoostCmd('111', {});
        expect(msgs('info')).toContain('Cost: 1 key — balance 0 → 0.');
    });

    test('a failed spend with only an error string shows it; with nothing, a default', async () => {
        h['key-unlock-boost'].mockResolvedValueOnce({ success: false, error: 'server said no' });
        await actions.unlockBoostCmd('111', { yes: true });
        h['fill-exposure'].mockResolvedValueOnce(invalid(undefined));
        await actions.fillExposureCmd('111', { yes: true });
        expect(msgs('error')).toEqual(['server said no', 'Action failed']);
    });

    test.each<['unlockBoostCmd' | 'fillExposureCmd', 'key-unlock-boost' | 'fill-exposure', string]>([
        ['unlockBoostCmd', 'key-unlock-boost', 'Failed to unlock boost'],
        ['fillExposureCmd', 'fill-exposure', 'Failed to fill exposure'],
    ])('%s: a thrown spend is reported (Error and non-Error)', async (fn, channel, prefix) => {
        h[channel].mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce('raw');
        await actions[fn]('111', { yes: true });
        await actions[fn]('111', { yes: true });
        expect(msgs('error')).toEqual([`${prefix}: boom`, `${prefix}: raw`]);
    });

    test('fill-exposure dry run needs no opts', async () => {
        await actions.fillExposureCmd('111');
        expect(h['fill-exposure']).not.toHaveBeenCalled();
        expect(msgs('info')).toContain('Cost: 1 fill — balance 1 → 0.');
    });
});

describe('swap', () => {
    test('parseSwapFlags reads --image / --to / --yes and treats empty values as missing', () => {
        expect(actions.parseSwapFlags(['--image=a', '--to=b', '--yes'])).toEqual({ imageId: 'a', to: 'b', yes: true });
        expect(actions.parseSwapFlags(['--image=', 'x'])).toEqual({ imageId: null, to: null, yes: false });
    });

    test.each([[undefined], [{}]])('missing --image is a usage error (opts=%p)', async (opts) => {
        await expect(actions.swapCmd('111', opts)).resolves.toBe(false);
        expect(msgs('error')[0]).toMatch(/--image=<id>/);
        expect(msgs('info')).toEqual([actions.SWAP_USAGE]);
    });

    test('a thrown preview is reported (Error and non-Error)', async () => {
        h['preview-swap-photo'].mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce('y');
        await actions.swapCmd('111', { imageId: 'a' });
        await actions.swapCmd('111', { imageId: 'a' });
        expect(msgs('error')).toEqual(['Failed to swap photo: x', 'Failed to swap photo: y']);
    });
});

describe('swap-back', () => {
    test('missing --image without opts is a usage error', async () => {
        await expect(actions.swapBackCmd('111')).resolves.toBe(false);
        expect(msgs('info')).toEqual([actions.SWAP_BACK_USAGE]);
    });

    test('no swap-back list at all reports nothing recorded', async () => {
        h['get-swap-backs'].mockResolvedValue(invalid(null));
        await expect(actions.swapBackCmd('111', { imageId: 'repl' })).resolves.toBe(true);
        expect(msgs('error')[0]).toMatch(/No swap back is recorded for repl/);
    });

    test('a thrown lookup is reported (Error and non-Error) and still returns true', async () => {
        h['get-swap-backs'].mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce('y');
        await expect(actions.swapBackCmd('111', { imageId: 'repl' })).resolves.toBe(true);
        await actions.swapBackCmd('111', { imageId: 'repl' });
        expect(msgs('error')).toEqual(['Failed to swap back: x', 'Failed to swap back: y']);
    });
});
