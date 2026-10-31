/**
 * The Capacitor bridge has no Electron main process, so logger fan-out can't
 * go through webContents.send. installBridge() instead wires
 * globalThis.sendLogToGUI to its in-process emitter, which is what the Logs
 * page subscribes to via onLogMessage. Without this the Logs page on Android
 * stays empty. The ipc handler modules / update services are mocked to keep
 * the bridge load light.
 */

import type * as capacitorModule from '../../src/ts/shells/capacitor/bridge/capacitor';
import type { GuiLogSink } from '../../src/ts/core/logger';
import type { WindowApi } from '../../src/ts/core/types/ipc';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/core/ipc/settings.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/voting.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/shells/capacitor/AndroidUpdateInstaller', () => ({ downloadAndInstall: jest.fn() }));
jest.mock('../../src/ts/core/services/visionVerifier', () => ({ hasBundledModel: async () => true }));
jest.mock('../../src/ts/core/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: () => 'https://example.com/releases',
}));
jest.mock('../../src/ts/core/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

const g = globalThis as typeof globalThis & { api?: object; sendLogToGUI?: GuiLogSink };

describe('Capacitor bridge — log streaming wiring', () => {
    let api: WindowApi;

    beforeEach(() => {
        delete g.api;
        delete g.sendLogToGUI;
        jest.resetModules();
        const { installBridge } = require('../../src/ts/shells/capacitor/bridge/capacitor') as typeof capacitorModule;
        api = installBridge();
    });

    afterEach(() => {
        delete g.sendLogToGUI;
        delete g.api;
    });

    test('installBridge wires globalThis.sendLogToGUI', () => {
        expect(typeof g.sendLogToGUI).toBe('function');
    });

    test('sendLogToGUI delivers entries to onLogMessage subscribers', () => {
        const received: unknown[] = [];
        api.onLogMessage((entry) => received.push(entry));

        g.sendLogToGUI!(invalid({ seq: 7, level: 'INFO', message: 'live' }));

        expect(received).toEqual([{ seq: 7, level: 'INFO', message: 'live' }]);
    });

    test('the onLogMessage unsubscribe stops delivery', () => {
        const received: unknown[] = [];
        const unsubscribe = api.onLogMessage((entry) => received.push(entry));

        unsubscribe();
        g.sendLogToGUI!(invalid({ seq: 8, message: 'after unsubscribe' }));

        expect(received).toEqual([]);
    });
});
