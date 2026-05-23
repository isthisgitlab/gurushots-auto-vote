/**
 * The Capacitor bridge has no Electron main process, so logger fan-out can't
 * go through webContents.send. installBridge() instead wires
 * globalThis.sendLogToGUI to its in-process emitter, which is what the Logs
 * page subscribes to via onLogMessage. Without this the Logs page on Android
 * stays empty. The ipc handler modules / update services are mocked to keep
 * the bridge load light.
 */

jest.mock('../../src/js/ipc/settings.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/voting.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/services/AndroidUpdateInstaller', () => ({ downloadAndInstall: jest.fn() }));
jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: () => 'https://example.com/releases',
}));
jest.mock('../../src/js/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

describe('Capacitor bridge — log streaming wiring', () => {
    let api;

    beforeEach(() => {
        delete globalThis.api;
        delete globalThis.sendLogToGUI;
        jest.resetModules();
        const { installBridge } = require('../../src/js/bridge/capacitor');
        api = installBridge();
    });

    afterEach(() => {
        delete globalThis.sendLogToGUI;
        delete globalThis.api;
    });

    test('installBridge wires globalThis.sendLogToGUI', () => {
        expect(typeof globalThis.sendLogToGUI).toBe('function');
    });

    test('sendLogToGUI delivers entries to onLogMessage subscribers', () => {
        const received = [];
        api.onLogMessage((entry) => received.push(entry));

        globalThis.sendLogToGUI({ seq: 7, level: 'INFO', message: 'live' });

        expect(received).toEqual([{ seq: 7, level: 'INFO', message: 'live' }]);
    });

    test('the onLogMessage unsubscribe stops delivery', () => {
        const received = [];
        const unsubscribe = api.onLogMessage((entry) => received.push(entry));

        unsubscribe();
        globalThis.sendLogToGUI({ seq: 8, message: 'after unsubscribe' });

        expect(received).toEqual([]);
    });
});
