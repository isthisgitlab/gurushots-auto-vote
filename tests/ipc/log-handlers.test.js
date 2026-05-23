/**
 * log.handlers stream lifecycle. The Capacitor bridge calls these handlers
 * with a null IPC event (single-process WebView), so start/stop-log-stream
 * must not throw on a missing event.sender. The Electron path still
 * registers a webContents and fans log entries out to it.
 */

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
