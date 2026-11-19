/**
 * Unit tests for the CLI `status` header's two automation lines (the CLI
 * parity of the GUI header indicators): "Auto-claim: on|off" and "Auto-join:
 * armed|off", read through the shared handlers. A fresh CLI process cannot
 * know the next claim time (it lives in the running app's process state), so
 * only the state is printed; a failed reply or a throwing handler prints
 * "could not be read" and never breaks status. logger, settings, the
 * middleware and the handlers are mocked.
 */

jest.mock('../../src/ts/core/logger', () => {
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

jest.mock('../../src/ts/core/settings', () => ({
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
    // The execution-mode lines: no running flag, no fence, no installation scenario.
    getSetting: jest.fn(() => false),
    readStopFence: jest.fn(() => ({ state: 'missing' })),
    getInstallationScenario: jest.fn(() => null),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
}));

// The mode lines read the installation's pause through the lifecycle handlers.
jest.mock('../../src/ts/core/ipc/scenarioLifecycle.handlers', () => {
    const handlers = { 'get-scenario-snapshot': jest.fn(async () => ({ success: true as const, paused: null })) };
    return { __handlers: handlers, buildLifecycleHandlers: () => handlers };
});

jest.mock('../../src/ts/shells/cli/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/ts/core/apiFactory', () => {
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

jest.mock('../../src/ts/core/ipc/actions.handlers', () => {
    const handlers = {
        'get-auto-claim-status': jest.fn(),
        'get-auto-join-active': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/core/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __infoMock: jest.Mock<void, [unknown]> }>(loggerModule));
import apiFactoryModule = require('../../src/ts/core/apiFactory');
type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __getActiveChallenges: jest.MockedFunction<Middleware['getActiveChallenges']>;
            __isAuthenticated: jest.MockedFunction<Middleware['isAuthenticated']>;
        }
    >(apiFactoryModule),
);
import type * as actionsHandlersModule from '../../src/ts/core/ipc/actions.handlers';
import type * as statusModule from '../../src/ts/shells/cli/commands/status';

type Handlers = ReturnType<typeof actionsHandlersModule.buildHandlers>;
type ClaimReply = Awaited<ReturnType<Handlers['get-auto-claim-status']>>;
type JoinReply = Awaited<ReturnType<Handlers['get-auto-join-active']>>;
const { __handlers } = require('../../src/ts/core/ipc/actions.handlers') as typeof actionsHandlersModule & {
    __handlers: {
        'get-auto-claim-status': jest.MockedFunction<() => Promise<ClaimReply>>;
        'get-auto-join-active': jest.MockedFunction<() => Promise<JoinReply>>;
    };
};
const { showStatus } = require('../../src/ts/shells/cli/commands/status') as typeof statusModule;

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

describe('CLI status — the execution mode lines', () => {
    const settings = jest.mocked(require('../../src/ts/core/settings') as typeof import('../../src/ts/core/settings'));
    const lifecycleMock = require('../../src/ts/core/ipc/scenarioLifecycle.handlers') as {
        __handlers: { 'get-scenario-snapshot': jest.MockedFunction<() => Promise<unknown>> };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        apiFactory.__isAuthenticated.mockReturnValue(false);
        // The module-factory defaults, restored: a test that overrides one leaves nothing for the next.
        settings.getSetting.mockReset().mockReturnValue(false);
        settings.readStopFence.mockReset().mockReturnValue(invalid({ state: 'missing' }));
        settings.getInstallationScenario.mockReset().mockReturnValue(null);
        lifecycleMock.__handlers['get-scenario-snapshot']
            .mockReset()
            .mockResolvedValue(invalid({ success: true, paused: null }));
    });

    test('a controller in this process answers the live mode', async () => {
        const { registerAutovoteControl } =
            require('../../src/ts/core/autovote/control') as typeof import('../../src/ts/core/autovote/control');
        const unregister = registerAutovoteControl({
            mode: () => 'armed',
            capture: () => ({ epoch: 0, generation: 0 }),
            admits: async () => true,
            request: async () => ({ ok: true, mode: 'armed', changed: false }),
        });
        try {
            await showStatus();
            expect(printedLines()).toContain('Execution mode: Scenario active; voting paused');
            // The live controller is its own authority: no last-reported line, no unavailable owner note.
            expect(printedLines().some((line) => line.startsWith('Last reported mode'))).toBe(false);
        } finally {
            unregister();
        }
    });

    test('the recorded running flag says Voting with its launch time', async () => {
        settings.getSetting.mockImplementation((key: string) =>
            key === 'autovoteRunning' ? true : key === 'autovoteStartedLaunch' ? 1_700_000_000_000 : false,
        );
        await showStatus();
        const line = printedLines().find((l) => l.startsWith('Last reported mode'));
        expect(line).toMatch(/^Last reported mode: Voting \((?!.*time unknown)/);
    });

    test('a running flag without a usable launch time says Voting with an unknown time', async () => {
        settings.getSetting.mockImplementation((key: string) => key === 'autovoteRunning');
        await showStatus();
        expect(printedLines()).toContain('Last reported mode: Voting (time unknown)');
    });

    test('a readable fence that never recorded a Stop says Stopped with an unknown time', async () => {
        settings.readStopFence.mockReturnValue(
            invalid({ state: 'ok', fence: { stopEpoch: 0, blocked: false, lastStop: null, lastArm: null } }),
        );
        await showStatus();
        expect(printedLines()).toContain('Last reported mode: Stopped (time unknown)');
    });

    test('a fence arm after the last Stop is never read as a live armed mode', async () => {
        settings.readStopFence.mockReturnValue(
            invalid({
                state: 'ok',
                fence: {
                    stopEpoch: 2,
                    blocked: true,
                    lastStop: { requestId: 'r1', at: 1_700_000_000_000, durable: true },
                    lastArm: { epoch: 2, at: 1_700_000_999_999 },
                },
            }),
        );
        await showStatus();
        const line = printedLines().find((l) => l.startsWith('Last reported mode'));
        expect(line).toMatch(/^Last reported mode: Stopped \(/);
        expect(line).not.toContain('time unknown');
        expect(line).not.toContain('armed');
    });

    test('an unreadable fence says Stopped with an unknown time', async () => {
        settings.readStopFence.mockReturnValue(invalid({ state: 'unreadable', reason: 'malformed' }));
        await showStatus();
        expect(printedLines()).toContain('Last reported mode: Stopped (time unknown)');
    });

    test('an installation scenario names its owner; a separate process cannot reach it, and the pause reason shows', async () => {
        settings.getInstallationScenario.mockReturnValue(
            invalid({ scenario: 'Night guard', executor: 'electron', generation: 1 }),
        );
        lifecycleMock.__handlers['get-scenario-snapshot'].mockResolvedValue(
            invalid({ success: true, paused: { reason: 'user asked', at: 100 } }),
        );
        await showStatus();
        const lines = printedLines();
        expect(lines).toContain('Installation scenario: Night guard');
        expect(lines).toContain('Installation owner: electron — owner status unavailable');
        expect(lines).toContain('Scenario paused: user asked');
    });

    test('a live scenario that is not paused prints no pause line', async () => {
        settings.getInstallationScenario.mockReturnValue(
            invalid({ scenario: 'Night guard', executor: 'electron', generation: 1 }),
        );
        await showStatus();
        const lines = printedLines();
        expect(lines.some((line) => line.startsWith('Scenario pause'))).toBe(false);
    });

    test('a controller in this process vouches for the owner: no unavailable note beside it', async () => {
        const { registerAutovoteControl } =
            require('../../src/ts/core/autovote/control') as typeof import('../../src/ts/core/autovote/control');
        settings.getInstallationScenario.mockReturnValue(
            invalid({ scenario: 'Night guard', executor: 'electron', generation: 1 }),
        );
        const unregister = registerAutovoteControl({
            mode: () => 'voting',
            capture: () => ({ epoch: 0, generation: 0 }),
            admits: async () => true,
            request: async () => ({ ok: true, mode: 'voting', changed: false }),
        });
        try {
            await showStatus();
            expect(printedLines()).toContain('Installation owner: electron');
            expect(printedLines()).not.toContain('Installation owner: electron — owner status unavailable');
        } finally {
            unregister();
        }
    });

    test('a pause that cannot be read says so, on a failed reply and on a throw', async () => {
        settings.getInstallationScenario.mockReturnValue(
            invalid({ scenario: 'Night guard', executor: 'cli', generation: 1 }),
        );
        lifecycleMock.__handlers['get-scenario-snapshot'].mockResolvedValue(invalid({ success: false }));
        await showStatus();
        expect(printedLines()).toContain('Scenario pause: could not be read');
        lifecycleMock.__handlers['get-scenario-snapshot'].mockRejectedValue(new Error('disk'));
        await showStatus();
        expect(printedLines()).toContain('Scenario pause: could not be read');
    });

    test('without an installation scenario the owner status is still unavailable to a separate process', async () => {
        await showStatus();
        const lines = printedLines();
        expect(lines).toContain('Installation scenario: none');
        expect(lines).toContain('Owner status unavailable (a running app reports its own state)');
    });
});
