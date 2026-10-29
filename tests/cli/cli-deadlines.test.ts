/**
 * Unit tests for the CLI `deadlines` command: the strict --challenge parsing,
 * the worded deadline-actions preview (never raw action kinds), the Boost/Turbo
 * conflict lines with the pin-release wording, and the exit codes — 1 on an
 * unknown or marked challenge, a failed handler reply, or a thrown handler.
 * The get-deadline-actions handler and the middleware are mocked; Date.now is
 * pinned so the due-in durations are exact.
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
    };
});

jest.mock('../../src/ts/ipc/computations.handlers', () => {
    const handlers = { 'get-deadline-actions': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

import { invalid } from '../helpers/invalid';
import type * as commandHandlersModule from '../../src/ts/cli/commandHandlers';
// The rows↔handlers cycle initialises only rows-first (commandRows reads the handlers'
// exports at module scope), so load the rows before reaching for their handlers.
require('../../src/ts/cli/commandRows');
const { runDeadlines } = require('../../src/ts/cli/commandHandlers') as typeof commandHandlersModule;
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
import type * as computationsHandlersModule from '../../src/ts/ipc/computations.handlers';
type HandlersMock = { __handlers: jest.Mocked<ReturnType<typeof computationsHandlersModule.buildHandlers>> };
const handlers = invalid<HandlersMock>(require('../../src/ts/ipc/computations.handlers')).__handlers;

const msgsAt = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const contains = (arr: string[], sub: string) => arr.some((s) => s.includes(sub));
const DEADLINES_USAGE = 'Usage: deadlines --challenge=<id>';

// A fixed instant, so the due-in durations the command formats are exact.
const NOW_MS = 1_799_999_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const reply = (extra: object = {}) => ({
    success: true as const,
    actions: [],
    boostBlocked: false,
    turboBlocked: false,
    boostBlockedBy: null,
    turboBlockedBy: null,
    boostReleaseAt: null,
    turboReleaseAt: null,
    boostPinSubmits: false,
    ...extra,
});

let dateSpy: jest.SpiedFunction<typeof Date.now>;

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
});

afterEach(() => {
    dateSpy.mockRestore();
});

describe('CLI deadlines — strict flags', () => {
    test('no arguments names what is missing and exits 1', async () => {
        await expect(runDeadlines([])).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Please specify a challenge id with --challenge')).toBe(true);
        expect(contains(msgsAt('info'), DEADLINES_USAGE)).toBe(true);
        expect(handlers['get-deadline-actions']).not.toHaveBeenCalled();
    });

    test.each([
        ['a space-form flag', ['--challenge', '111']],
        ['an empty value', ['--challenge=']],
        ['a repeated flag', ['--challenge=111', '--challenge=222']],
        ['a stray argument', ['--challenge=111', 'extra']],
        ['an unknown flag', ['--challenge=111', '--stats']],
    ])('%s prints the usage and exits 1', async (_label, argv) => {
        await expect(runDeadlines(argv)).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), DEADLINES_USAGE)).toBe(true);
        expect(handlers['get-deadline-actions']).not.toHaveBeenCalled();
    });
});

describe('CLI deadlines — the preview', () => {
    test('prints each worded action kind with its due time, and no raw kind', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(
            invalid({
                success: true,
                actions: [
                    { action: 'autoSubmit', thresholdSec: 1800, dueAt: NOW_SEC + 1800 },
                    { action: 'turbo', thresholdSec: 7200, dueAt: NOW_SEC + 7200 },
                    { action: 'emergencySubmit', thresholdSec: 300, dueAt: NOW_SEC - 5 },
                    { action: 'boost', thresholdSec: 900, dueAt: null },
                ],
            }),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'Deadline actions for "Sunset":')).toBe(true);
        expect(contains(msgsAt('info'), 'Auto-submit: due in 30m')).toBe(true);
        expect(contains(msgsAt('info'), 'Turbo: due in 2h 0m')).toBe(true);
        expect(contains(msgsAt('info'), 'Emergency submit: due now')).toBe(true);
        expect(contains(msgsAt('info'), 'Boost: no due time could be read for it')).toBe(true);
        expect(contains(msgsAt('info'), 'autoSubmit')).toBe(false);
        expect(contains(msgsAt('info'), 'emergencySubmit')).toBe(false);
    });

    test('an empty action list says nothing is scheduled to run by itself', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(invalid(reply()));

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'Nothing is scheduled to run by itself on this challenge.')).toBe(true);
    });

    test('a flag block names the other feature and says unpinning cannot help', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(
            invalid(reply({ boostBlocked: true, boostBlockedBy: 'flag' })),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'Boost is blocked: every entry carries the other feature (Turbo)')).toBe(true);
        expect(contains(msgsAt('info'), 'Turbo is blocked')).toBe(false);
    });

    test('a pin block names when the pin gives way', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(
            invalid(reply({ turboBlocked: true, turboBlockedBy: 'pin', turboReleaseAt: NOW_SEC + 600 })),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'Turbo is blocked: the photo pinned for Boost is in the way')).toBe(true);
        expect(contains(msgsAt('info'), 'The pin gives way in 10m, or unpin it to use Turbo sooner.')).toBe(true);
    });

    test('a pin block that never gives way says so', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(
            invalid(reply({ turboBlocked: true, turboBlockedBy: 'pin', turboReleaseAt: null })),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'the pin will not give way on its own. Unpin it or add another entry.')).toBe(
            true,
        );
    });

    test('both conflicts can print together', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(
            invalid(
                reply({
                    boostBlocked: true,
                    turboBlocked: true,
                    boostBlockedBy: 'flag',
                    turboBlockedBy: 'pin',
                    turboReleaseAt: NOW_SEC + 60,
                }),
            ),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(contains(msgsAt('info'), 'Boost is blocked: every entry carries the other feature (Turbo)')).toBe(true);
        expect(contains(msgsAt('info'), 'Turbo is blocked: the photo pinned for Boost is in the way')).toBe(true);
    });
});

describe('CLI deadlines — refusals', () => {
    test('a marked challenge refuses with words and never reaches the handler', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: 'Sunset', dataIssues: ['close_time'] }] }),
        );

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(1);

        expect(handlers['get-deadline-actions']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'challenge data cannot be read')).toBe(true);
    });

    test('an unknown id exits 1', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await expect(runDeadlines(['--challenge=999'])).resolves.toBe(1);

        expect(handlers['get-deadline-actions']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });

    test('a failed handler reply is worded and exits 1, never the raw error', async () => {
        handlers['get-deadline-actions'].mockResolvedValue({ success: false, error: 'invalid challenge id' });

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Could not read the deadline actions for "Sunset"')).toBe(true);
        expect(contains(msgsAt('error'), 'invalid challenge id')).toBe(true);
    });

    test('a thrown handler exits 1', async () => {
        handlers['get-deadline-actions'].mockRejectedValue(new Error('boom'));

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to read the deadline actions')).toBe(true);
    });

    test('a thrown non-Error is stringified into the failure line', async () => {
        handlers['get-deadline-actions'].mockRejectedValue('disk');

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to read the deadline actions: disk')).toBe(true);
    });

    test('a failed reply with no error text says it got no answer', async () => {
        handlers['get-deadline-actions'].mockResolvedValue(invalid({ success: false }));

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'no answer')).toBe(true);
    });

    test('a title carrying terminal control codes is stripped', async () => {
        const esc = String.fromCharCode(27);
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: `Sun${esc}[31mset` }] }),
        );
        handlers['get-deadline-actions'].mockResolvedValue(invalid(reply()));

        await expect(runDeadlines(['--challenge=111'])).resolves.toBe(0);

        expect(msgsAt('info').some((s) => s.includes(esc))).toBe(false);
    });
});
