/**
 * Unit tests for the CLI `status` header's two automation lines (the CLI
 * parity of the GUI header indicators): "Auto-claim: on|off" and "Auto-join:
 * armed|off", read through the shared handlers. A fresh CLI process cannot
 * know the next claim time (it lives in the running app's process state), so
 * only the state is printed; a failed reply or a throwing handler prints
 * "could not be read" and never breaks status. logger, settings, the
 * middleware and the handlers are mocked.
 */

jest.mock('../../src/ts/logger', () => {
    const infoMock = jest.fn();
    return {
        __infoMock: infoMock,
        withCategory: jest.fn(() => ({
            info: infoMock,
            error: infoMock,
            success: infoMock,
            warning: infoMock,
            startOperation: jest.fn(),
            endOperation: jest.fn(),
        })),
    };
});

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({
        app: {
            mock: true,
            theme: 'latvian',
            language: 'english',
            timezone: 'Europe/Riga',
            apiTimeout: 30,
            checkFrequencyMin: 1,
            checkFrequencyMax: 1,
        },
        auth: { token: 'tok' },
        challenges: {},
    })),
    getEffectiveSetting: jest.fn(() => 1),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
}));

jest.mock('../../src/ts/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/ts/apiFactory', () => {
    const mockGetActiveChallenges = jest.fn();
    const mockIsAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: mockGetActiveChallenges,
        __isAuthenticated: mockIsAuthenticated,
        getMiddleware: jest.fn(() => ({
            isAuthenticated: mockIsAuthenticated,
            getActiveChallenges: mockGetActiveChallenges,
        })),
    };
});

jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = {
        'get-auto-claim-status': jest.fn(),
        'get-auto-join-active': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __infoMock: jest.Mock<void, [unknown]> }>(loggerModule));
import apiFactoryModule = require('../../src/ts/apiFactory');
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
import type * as votingModule from '../../src/ts/cli/commands/voting';

type Handlers = ReturnType<typeof actionsHandlersModule.buildHandlers>;
type ClaimReply = Awaited<ReturnType<Handlers['get-auto-claim-status']>>;
type JoinReply = Awaited<ReturnType<Handlers['get-auto-join-active']>>;
const { __handlers } = require('../../src/ts/ipc/actions.handlers') as typeof actionsHandlersModule & {
    __handlers: {
        'get-auto-claim-status': jest.MockedFunction<() => Promise<ClaimReply>>;
        'get-auto-join-active': jest.MockedFunction<() => Promise<JoinReply>>;
    };
};
const { showStatus } = require('../../src/ts/cli/commands/voting') as typeof votingModule;

const printedLines = () =>
    logger.__infoMock.mock.calls.map((c) => c[0]).filter((s): s is string => typeof s === 'string');

const claimReply = (reply: ClaimReply | Promise<ClaimReply>) =>
    __handlers['get-auto-claim-status'].mockResolvedValue(reply);
const joinReply = (reply: JoinReply | Promise<JoinReply>) =>
    __handlers['get-auto-join-active'].mockResolvedValue(reply);

describe('CLI status — automation lines', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        apiFactory.__isAuthenticated.mockReturnValue(true);
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });
    });

    test('prints on for an enabled auto-claim and armed for an active auto-join', async () => {
        claimReply(invalid<ClaimReply>({ success: true, enabled: true, nextClaimAt: 1760000000000 }));
        joinReply(invalid<JoinReply>({ success: true, active: true }));

        await showStatus();

        const lines = printedLines();
        expect(lines).toContain('Auto-claim: on');
        expect(lines).toContain('Auto-join: armed');
        // The claim line comes before the join line, and a fresh CLI process
        // never prints the next claim time (process-local state).
        expect(lines.indexOf('Auto-claim: on')).toBeLessThan(lines.indexOf('Auto-join: armed'));
        expect(lines.some((line) => line.includes('1760000000000'))).toBe(false);
    });

    test('prints off for a disabled auto-claim and a passive auto-join', async () => {
        claimReply(invalid<ClaimReply>({ success: true, enabled: false, nextClaimAt: 0 }));
        joinReply(invalid<JoinReply>({ success: true, active: false }));

        await showStatus();

        expect(printedLines()).toContain('Auto-claim: off');
        expect(printedLines()).toContain('Auto-join: off');
    });

    test('a failed reply is not off: the line says it could not be read', async () => {
        claimReply(invalid<ClaimReply>({ success: false, error: 'Could not read auto-claim status' }));
        joinReply(invalid<JoinReply>({ success: false, active: false }));

        await showStatus();

        expect(printedLines()).toContain('Auto-claim: could not be read');
        expect(printedLines()).toContain('Auto-join: could not be read');
    });

    test('a throwing handler reads "could not be read" and never breaks status', async () => {
        __handlers['get-auto-claim-status'].mockRejectedValue(new Error('disk on fire'));
        __handlers['get-auto-join-active'].mockRejectedValue(new Error('disk on fire'));

        await expect(showStatus()).resolves.toBeUndefined();

        expect(printedLines()).toContain('Auto-claim: could not be read');
        expect(printedLines()).toContain('Auto-join: could not be read');
    });

    test('the header lines print even when not authenticated', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);
        claimReply(invalid<ClaimReply>({ success: true, enabled: true, nextClaimAt: 0 }));
        joinReply(invalid<JoinReply>({ success: true, active: true }));

        await showStatus();

        expect(printedLines()).toContain('Auto-claim: on');
        expect(printedLines()).toContain('Auto-join: armed');
        // The sections that need the API stay out.
        expect(printedLines()).not.toContain('\nBoost Window Open:');
    });
});
