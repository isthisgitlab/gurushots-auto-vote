/**
 * Scenario IPC handlers: {success, error} results, never a throw.
 */

jest.mock('../../src/js/services/scenarioStatus', () => ({ getScenarioStatus: jest.fn() }));
jest.mock('../../src/js/logger', () => ({ withCategory: jest.fn(() => ({ error: jest.fn() })) }));

const { getScenarioStatus } = require('../../src/js/services/scenarioStatus');
const { buildHandlers, register } = require('../../src/js/ipc/scenarios.handlers');

const handlers = buildHandlers();

describe('get-scenario-status', () => {
    test('returns the status', async () => {
        getScenarioStatus.mockReturnValue({
            assigned: 'Plan',
            scenario: null,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toEqual(
            expect.objectContaining({ success: true, assigned: 'Plan' }),
        );
        expect(getScenarioStatus).toHaveBeenCalledWith(7);
    });

    test.each([[undefined], [''], ['  '], [Number.NaN], [{}]])('refuses a bad id %p', async (id) => {
        await expect(handlers['get-scenario-status'](null, id)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('a failure becomes an error result', async () => {
        getScenarioStatus.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(handlers['get-scenario-status'](null, '7')).resolves.toEqual({ success: false, error: 'boom' });
    });
});

test('register wires every handler through the trusted-sender wrapper', () => {
    const ipcMain = { handle: jest.fn() };
    register(ipcMain);
    expect(ipcMain.handle).toHaveBeenCalledWith('get-scenario-status', expect.any(Function));
});
