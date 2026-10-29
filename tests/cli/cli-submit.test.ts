/**
 * Unit tests for the CLI `submit` command: the strict flag parsing (modeled on
 * `turbo`'s) and the real exit codes both submit paths share — 0 sent, 1 failed
 * (including an unknown id and the catch path), 2 when the submit got no answer
 * (`submit-unclear`: the photo(s) may have been submitted, never shown as a
 * failure). `--image=<ids>` goes to submit-picked-photos exactly as named; the
 * auto path (no --image) keeps fill-challenge-now. The handlers and the
 * middleware are mocked; every fixed submit code is asserted worded, never raw.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown; data?: unknown }[] = [];
    const rec = (level: string) => (msg: unknown, data?: unknown) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat), CATEGORIES: {} };
});

jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn(() => 'tok'),
    loadSettings: jest.fn(() => ({ app: { mock: true }, auth: { token: 'tok' } })),
}));

jest.mock('../../src/ts/apiFactory', () => {
    const getActiveChallenges = jest.fn();
    const isAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: getActiveChallenges,
        __isAuthenticated: isAuthenticated,
        getMiddleware: jest.fn(() => ({ isAuthenticated, getActiveChallenges })),
        getApiStrategy: jest.fn(),
        refreshApi: jest.fn(),
    };
});

jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = {
        'fill-challenge-now': jest.fn(),
        'submit-picked-photos': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

import { invalid } from '../helpers/invalid';
import type * as actionHandlersModule from '../../src/ts/cli/actionHandlers';
// The rows↔handlers cycle initialises only rows-first (commandRows reads the handlers'
// exports at module scope), so load the rows before reaching for their handlers.
require('../../src/ts/cli/commandRows');
const { runSubmit } = require('../../src/ts/cli/actionHandlers') as typeof actionHandlersModule;
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __calls: { level: string; msg: unknown; data?: unknown }[] }>(loggerModule),
);
import apiFactoryModule = require('../../src/ts/apiFactory');
// The middleware whose methods the factory mock exposes as __-prefixed jest.fns.
type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __getActiveChallenges: jest.MockedFunction<Middleware['getActiveChallenges']>;
            __isAuthenticated: jest.MockedFunction<Middleware['isAuthenticated']>;
        }
    >(apiFactoryModule),
);
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
type HandlersMock = { __handlers: jest.Mocked<ReturnType<typeof actionsHandlersModule.buildHandlers>> };
const handlers = invalid<HandlersMock>(require('../../src/ts/ipc/actions.handlers')).__handlers;

const msgsAt = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const allMsgs = () => logger.__calls.map((c) => String(c.msg));
const contains = (arr: string[], sub: string) => arr.some((s) => s.includes(sub));
const SUBMIT_USAGE = 'Usage: submit --challenge=<id> [--all | --image=<id>[,<id>…]]';

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
});

describe('CLI submit — strict flags', () => {
    test.each([
        ['a typo flag', ['--images=img9']],
        ['a repeated flag', ['--image=img9', '--image=img8']],
        ['a repeated --all', ['--all', '--all']],
        ['a space-form flag', ['--image', 'img9']],
        ['--all with --image together', ['--all', '--image=img9']],
        ['a stray argument', ['img9']],
    ])('%s prints the usage and exits 1', async (_label, rest) => {
        await expect(runSubmit(['--challenge=111', ...rest])).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), SUBMIT_USAGE)).toBe(true);
        expect(handlers['submit-picked-photos']).not.toHaveBeenCalled();
        expect(handlers['fill-challenge-now']).not.toHaveBeenCalled();
    });

    test('an empty --image= names what is missing and exits 1', async () => {
        await expect(runSubmit(['--challenge=111', '--image='])).resolves.toBe(1);
        expect(contains(msgsAt('error'), '--image needs a photo id')).toBe(true);
        expect(handlers['submit-picked-photos']).not.toHaveBeenCalled();
    });
});

describe('CLI submit --image (picked photos)', () => {
    test('one id goes to submit-picked-photos exactly as named and exits 0', async () => {
        handlers['submit-picked-photos'].mockResolvedValue(invalid({ success: true, submitted: 1 }));

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(0);

        expect(handlers['submit-picked-photos']).toHaveBeenCalledWith(null, '111', ['img1']);
        expect(handlers['fill-challenge-now']).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'Submitted 1 photo(s) to "Sunset"')).toBe(true);
    });

    test('several comma-separated ids are passed as the list', async () => {
        handlers['submit-picked-photos'].mockResolvedValue(invalid({ success: true, submitted: 3 }));

        await expect(runSubmit(['--challenge=111', '--image=img1,img2,img3'])).resolves.toBe(0);

        expect(handlers['submit-picked-photos']).toHaveBeenCalledWith(null, '111', ['img1', 'img2', 'img3']);
    });

    test.each([
        ['not-enough-slots', 'fewer open slots than photos'],
        ['already-entered', 'already entered in this challenge'],
        ['submit-rejected', 'GuruShots rejected the submit'],
        ['submit-busy', 'submit for this challenge is already running'],
    ])('the %s code is worded from the shared table and exits 1', async (code, wording) => {
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: code });

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), wording)).toBe(true);
        expect(contains(allMsgs(), code)).toBe(false);
    });

    test('the invalid-args code reads as the invalid-id wording, never the raw code', async () => {
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: 'invalid-args' });

        await expect(runSubmit(['--challenge=111', '--image=not an id'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Invalid challenge or image id.')).toBe(true);
        expect(contains(allMsgs(), 'invalid-args')).toBe(false);
    });

    test('submit-unclear says the photo(s) may have been submitted and exits 2, never as a failure', async () => {
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: 'submit-unclear' });

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(2);

        expect(contains(msgsAt('warning'), 'may have been submitted')).toBe(true);
        expect(contains(msgsAt('warning'), 'Check the challenge before retrying')).toBe(true);
        expect(msgsAt('error')).toEqual([]);
        expect(contains(allMsgs(), 'submit-unclear')).toBe(false);
    });

    test('a failed reply carrying free text exits 1', async () => {
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: 'Challenge no longer active' });

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Challenge no longer active')).toBe(true);
    });

    test('a challenge-data-incomplete refusal reads as words, never the raw code', async () => {
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: 'challenge-data-incomplete' });

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), "challenge's data cannot be read")).toBe(true);
        expect(contains(allMsgs(), 'challenge-data-incomplete')).toBe(false);
    });

    test('an unknown id exits 1 without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await expect(runSubmit(['--challenge=999', '--image=img1'])).resolves.toBe(1);

        expect(handlers['submit-picked-photos']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });

    test('a thrown handler exits 1', async () => {
        handlers['submit-picked-photos'].mockRejectedValue(new Error('boom'));

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to submit photos')).toBe(true);
    });

    test('a thrown non-Error is stringified into the failure line', async () => {
        handlers['submit-picked-photos'].mockRejectedValue('disk');

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to submit photos: disk')).toBe(true);
    });

    test('an error string carrying terminal control codes is stripped before printing', async () => {
        const esc = String.fromCharCode(27);
        handlers['submit-picked-photos'].mockResolvedValue({ success: false, error: `Nope ${esc}[31mnope${esc}[0m` });

        await expect(runSubmit(['--challenge=111', '--image=img1'])).resolves.toBe(1);

        const errors = msgsAt('error');
        expect(contains(errors, 'Nope nope')).toBe(true);
        expect(errors.some((s) => s.includes(esc))).toBe(false);
    });
});

describe('CLI submit — auto path (fill-challenge-now)', () => {
    test('no flags fills one slot and exits 0', async () => {
        handlers['fill-challenge-now'].mockResolvedValue(invalid({ success: true, submitted: 1, skipped: 0 }));

        await expect(runSubmit(['--challenge=111'])).resolves.toBe(0);

        expect(handlers['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'one');
        expect(handlers['submit-picked-photos']).not.toHaveBeenCalled();
    });

    test('--all fills every empty slot', async () => {
        handlers['fill-challenge-now'].mockResolvedValue(invalid({ success: true, submitted: 2, skipped: 1 }));

        await expect(runSubmit(['--challenge=111', '--all'])).resolves.toBe(0);

        expect(handlers['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'all');
    });

    test('the auto path answers submit-unclear with the same wording and exits 2', async () => {
        handlers['fill-challenge-now'].mockResolvedValue({ success: false, error: 'submit-unclear' });

        await expect(runSubmit(['--challenge=111'])).resolves.toBe(2);

        expect(contains(msgsAt('warning'), 'may have been submitted')).toBe(true);
        expect(msgsAt('error')).toEqual([]);
    });

    test('a free-text auto-path failure prints stripped and exits 1', async () => {
        const esc = String.fromCharCode(27);
        handlers['fill-challenge-now'].mockResolvedValue({ success: false, error: `Rejected ${esc}[31mhard${esc}[0m` });

        await expect(runSubmit(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Rejected hard')).toBe(true);
        expect(msgsAt('error').some((s) => s.includes(esc))).toBe(false);
    });

    test('an unknown id exits 1 without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await expect(runSubmit(['--challenge=999'])).resolves.toBe(1);

        expect(handlers['fill-challenge-now']).not.toHaveBeenCalled();
    });

    test('a thrown handler exits 1', async () => {
        handlers['fill-challenge-now'].mockRejectedValue(new Error('boom'));

        await expect(runSubmit(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to submit photos')).toBe(true);
    });
});
