/**
 * invokeHandler: the one place renderer arguments reach a handler. On a dirty build it records the call, its reply
 * or its failure in the debug log, and the reply or the throw reaches the caller exactly as the handler gave it.
 * The logger is the global mock: `debugLogEnabled` stands for the dirty-build gate.
 */

import type * as loggerModule from '../../src/ts/core/logger';
import type * as invokeHandlerModule from '../../src/ts/core/ipc/invokeHandler';

const logger = jest.mocked(require('../../src/ts/core/logger') as typeof loggerModule);
const { invokeHandler } = require('../../src/ts/core/ipc/invokeHandler') as typeof invokeHandlerModule;

type Handler = Parameters<typeof invokeHandler>[1];

const recorded = () => logger.writeDebug.mock.calls.map(([kind, message, data]) => [kind, message, data]);

afterEach(() => {
    logger.debugLogEnabled.mockReturnValue(false);
});

describe('with the debug log off', () => {
    test('calls the handler with the event and the arguments, records nothing, returns the value as is', () => {
        const value = { success: true };
        const handler = jest.fn(() => value);
        const event = null;
        expect(invokeHandler('get-setting', handler as Handler, event, ['theme', 1])).toBe(value);
        expect(handler).toHaveBeenCalledWith(event, 'theme', 1);
        expect(logger.writeDebug).not.toHaveBeenCalled();
    });
});

describe('with the debug log on', () => {
    beforeEach(() => {
        logger.debugLogEnabled.mockReturnValue(true);
    });

    test('a synchronous value is recorded in and out and returned as is', () => {
        const value = { success: true };
        const handler = jest.fn(() => value);
        expect(invokeHandler('get-setting', handler as Handler, null, ['theme'])).toBe(value);
        expect(handler).toHaveBeenCalledWith(null, 'theme');
        expect(recorded()).toEqual([
            ['ipc-in', 'get-setting', { channel: 'get-setting', args: ['theme'] }],
            ['ipc-out', 'get-setting', { channel: 'get-setting', result: value }],
        ]);
    });

    test('a resolved promise is recorded in at once and out when it settles, with the value unchanged', async () => {
        const value = { success: true };
        const pending = invokeHandler('save-settings', (async () => value) as Handler, null, [{ a: 1 }]);
        expect(recorded().map(([kind]) => kind)).toEqual(['ipc-in']);
        await expect(pending).resolves.toBe(value);
        expect(recorded()).toEqual([
            ['ipc-in', 'save-settings', { channel: 'save-settings', args: [{ a: 1 }] }],
            ['ipc-out', 'save-settings', { channel: 'save-settings', result: value }],
        ]);
    });

    test('a rejected promise is recorded as an error and rejects with the same error, never unhandled', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const boom = new Error('boom');
            const pending = invokeHandler('save-settings', (async () => Promise.reject(boom)) as Handler, null, []);
            await expect(pending).rejects.toBe(boom);
            await new Promise((resolve) => setImmediate(resolve));
            expect(unhandled).not.toHaveBeenCalled();
            expect(recorded()).toEqual([
                ['ipc-in', 'save-settings', { channel: 'save-settings', args: [] }],
                ['ipc-error', 'save-settings', { channel: 'save-settings', error: boom }],
            ]);
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    test('a synchronous throw is recorded and rethrown synchronously, unchanged', () => {
        const boom = new Error('sync boom');
        const handler = (() => {
            throw boom;
        }) as Handler;
        let thrown: unknown;
        try {
            invokeHandler('get-setting', handler, null, []);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBe(boom);
        expect(recorded()).toEqual([
            ['ipc-in', 'get-setting', { channel: 'get-setting', args: [] }],
            ['ipc-error', 'get-setting', { channel: 'get-setting', error: boom }],
        ]);
    });

    test('a thenable that is not a promise is followed too', async () => {
        const thenable = { then: (resolve: (value: string) => void) => resolve('late') };
        await expect(invokeHandler('get-setting', (() => thenable) as Handler, null, [])).resolves.toBe('late');
        expect(recorded().map(([kind]) => kind)).toEqual(['ipc-in', 'ipc-out']);
    });

    test.each([
        'log-debug',
        'log-error',
        'log-warning',
        'log-api',
        'log-remote-info',
        'get-log-backlog',
        'get-log-file',
        'get-error-log-file',
        'get-api-log-file',
    ])('%s is not recorded (it would copy the logs into the debug log), but still runs', (channel) => {
        const handler = jest.fn(() => 'ran');
        expect(invokeHandler(channel, handler as Handler, null, ['x'])).toBe('ran');
        expect(handler).toHaveBeenCalledWith(null, 'x');
        expect(logger.writeDebug).not.toHaveBeenCalled();
    });
});
