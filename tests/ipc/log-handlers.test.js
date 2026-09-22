/**
 * log.handlers stream lifecycle. The Capacitor bridge calls these handlers
 * with a null IPC event (single-process WebView), so start/stop-log-stream
 * must not throw on a missing event.sender. The Electron path still
 * registers a webContents and fans log entries out to it.
 */

jest.mock('../../src/js/logger', () => {
    const categories = {};
    const withCategory = jest.fn((name) => {
        categories[name] = categories[name] || {
            debug: jest.fn(),
            error: jest.fn(),
            warning: jest.fn(),
            api: jest.fn(),
        };
        return categories[name];
    });
    return {
        categories,
        withCategory,
        setContext: jest.fn(),
        clearContext: jest.fn(),
        getLogFile: jest.fn(() => '/logs/app.log'),
        getErrorLogFile: jest.fn(() => '/logs/error.log'),
        getApiLogFile: jest.fn(() => '/logs/api.log'),
        getRecentLogs: jest.fn(() => [{ seq: 1, message: 'old' }]),
    };
});

describe('log.handlers — stream lifecycle', () => {
    let logHandlers;
    let handlers;

    // Re-require per test so the module-level logStreamWindows set starts
    // empty each time — no registered webContents bleeds across tests.
    beforeEach(() => {
        jest.resetModules();
        logHandlers = require('../../src/js/ipc/log.handlers');
        handlers = logHandlers.buildHandlers();
    });

    test('start/stop-log-stream acknowledge with no IPC event (Capacitor path)', async () => {
        await expect(handlers['start-log-stream'](null)).resolves.toEqual({ success: true });
        await expect(handlers['stop-log-stream'](null)).resolves.toEqual({ success: true });
        await expect(handlers['start-log-stream'](undefined)).resolves.toEqual({ success: true });
        await expect(handlers['start-log-stream']({})).resolves.toEqual({ success: true });
        await expect(handlers['stop-log-stream']({})).resolves.toEqual({ success: true });
    });

    test('Electron path registers a webContents and fans entries out to it', async () => {
        const sender = { on: jest.fn(), send: jest.fn(), isDestroyed: () => false };
        await handlers['start-log-stream']({ sender });

        logHandlers.sendLogToGUI({ seq: 1, message: 'hi' });
        expect(sender.send).toHaveBeenCalledWith('log-message', { seq: 1, message: 'hi' });

        await handlers['stop-log-stream']({ sender });
        sender.send.mockClear();
        logHandlers.sendLogToGUI({ seq: 2, message: 'bye' });
        expect(sender.send).not.toHaveBeenCalled();
    });
});

describe('log.handlers — renderer log writes and file lookups', () => {
    let logger;
    let handlers;

    beforeEach(() => {
        jest.resetModules();
        logger = require('../../src/js/logger');
        handlers = require('../../src/js/ipc/log.handlers').buildHandlers();
    });

    test.each([
        ['log-debug', 'ui', 'debug'],
        ['log-error', 'ui', 'error'],
        ['log-warning', 'ui', 'warning'],
        ['log-api', 'api', 'api'],
    ])('%s logs under the GUI context via %s.%s and clears the context', async (channel, category, level) => {
        const data = { k: 1 };
        await expect(handlers[channel]({}, 'msg', data)).resolves.toEqual({ success: true });

        expect(logger.setContext).toHaveBeenCalledWith('GUI');
        expect(logger.withCategory).toHaveBeenCalledWith(category);
        expect(logger.categories[category][level]).toHaveBeenCalledWith('msg', data);
        expect(logger.clearContext).toHaveBeenCalledTimes(1);
        // Context is set before the write and cleared after it.
        expect(logger.setContext.mock.invocationCallOrder[0]).toBeLessThan(
            logger.clearContext.mock.invocationCallOrder[0],
        );
    });

    test.each([
        ['get-log-file', '/logs/app.log'],
        ['get-error-log-file', '/logs/error.log'],
        ['get-api-log-file', '/logs/api.log'],
    ])('%s returns the logger path', async (channel, expected) => {
        await expect(handlers[channel]()).resolves.toBe(expected);
    });

    test('get-log-backlog returns the recent log ring', async () => {
        await expect(handlers['get-log-backlog']()).resolves.toEqual([{ seq: 1, message: 'old' }]);
    });
});

describe('log.handlers — stream edge cases and register', () => {
    let logHandlers;
    let handlers;
    let logger;

    beforeEach(() => {
        jest.resetModules();
        logger = require('../../src/js/logger');
        logHandlers = require('../../src/js/ipc/log.handlers');
        handlers = logHandlers.buildHandlers();
    });

    afterEach(() => {
        delete global.sendLogToGUI;
    });

    test('a destroyed webContents is unregistered via its destroyed event', async () => {
        const listeners = {};
        const sender = {
            on: jest.fn((evt, cb) => {
                listeners[evt] = cb;
            }),
            send: jest.fn(),
            isDestroyed: () => false,
        };
        await handlers['start-log-stream']({ sender });
        expect(sender.on).toHaveBeenCalledWith('destroyed', expect.any(Function));

        listeners.destroyed();
        logHandlers.sendLogToGUI({ seq: 3 });
        expect(sender.send).not.toHaveBeenCalled();
    });

    test('sendLogToGUI skips a webContents that reports isDestroyed()', async () => {
        const live = { on: jest.fn(), send: jest.fn(), isDestroyed: () => false };
        const dead = { on: jest.fn(), send: jest.fn(), isDestroyed: () => true };
        await handlers['start-log-stream']({ sender: live });
        await handlers['start-log-stream']({ sender: dead });

        logHandlers.sendLogToGUI({ seq: 4 });
        expect(live.send).toHaveBeenCalledWith('log-message', { seq: 4 });
        expect(dead.send).not.toHaveBeenCalled();
    });

    test('start-log-stream returns the error envelope when the sender cannot be subscribed', async () => {
        const sender = {
            on: jest.fn(() => {
                throw new Error('gone');
            }),
        };
        await expect(handlers['start-log-stream']({ sender })).resolves.toEqual({ success: false, error: 'gone' });
        expect(logger.categories.ui.error).toHaveBeenCalledWith('Error starting log stream:', expect.any(Error));
    });

    test('stop-log-stream returns the error envelope when reading the sender throws', async () => {
        const event = {
            get sender() {
                throw new Error('disposed');
            },
        };
        await expect(handlers['stop-log-stream'](event)).resolves.toEqual({ success: false, error: 'disposed' });
        expect(logger.categories.ui.error).toHaveBeenCalledWith('Error stopping log stream:', expect.any(Error));
    });

    test('register wires every channel and installs the global fan-out hook', async () => {
        const channels = new Map();
        logHandlers.register({ handle: (channel, impl) => channels.set(channel, impl) });

        expect([...channels.keys()].sort()).toEqual(Object.keys(handlers).sort());
        expect(global.sendLogToGUI).toBe(logHandlers.sendLogToGUI);
        await expect(channels.get('get-log-file')(undefined)).resolves.toBe('/logs/app.log');
    });
});
