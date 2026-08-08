/**
 * Channel-manifest drift test — the enforcement half of R4's "a new channel
 * can't silently miss one platform" guarantee.
 *
 * Asserts set-equality between the manifest's invoke surface
 * (invokeChannels ∪ alias targets) and the union of every
 * ipc/*.handlers.js buildHandlers() key, and between the manifest's
 * sendMethods channels and index.js's direct ipcMain.on registrations
 * (login-success / logout live there, not in a handlers module).
 *
 * Coverage is name-level only: a signature change on a channel present on
 * both sides is not caught here.
 */

jest.mock('electron', () => ({
    app: { getVersion: jest.fn(() => '0.0.0'), isPackaged: false },
    shell: { openExternal: jest.fn() },
    BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock('electron-updater', () => ({
    autoUpdater: { on: jest.fn(), setFeedURL: jest.fn() },
}));
jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory', () => ({
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
    refreshApi: jest.fn(),
}));
jest.mock('../../src/js/ui/applicationMenu', () => ({
    updateMenuTranslations: jest.fn(),
}));

const fs = jest.requireActual('fs');
const path = require('path');

const {
    invokeChannels,
    aliases,
    sendMethods,
    eventMethods,
    kebabToCamel,
    allInvokeChannels,
} = require('../../src/js/ipc/manifest');

const collectHandlerChannels = () => {
    const settingsHandlers = require('../../src/js/ipc/settings.handlers');
    const votingHandlers = require('../../src/js/ipc/voting.handlers');
    const logHandlers = require('../../src/js/ipc/log.handlers');
    const actionsHandlers = require('../../src/js/ipc/actions.handlers');
    const miscHandlers = require('../../src/js/ipc/misc.handlers');
    const updateHandlers = require('../../src/js/ipc/update.handlers');

    return [
        ...Object.keys(settingsHandlers.buildHandlers({ broadcastSettingsChange: () => {} })),
        ...Object.keys(votingHandlers.buildHandlers()),
        ...Object.keys(logHandlers.buildHandlers()),
        ...Object.keys(actionsHandlers.buildHandlers()),
        ...Object.keys(miscHandlers.buildHandlers({ getMainWindow: () => null, getLoginWindow: () => null })),
        ...Object.keys(
            updateHandlers.buildHandlers({
                getAutoUpdater: () => null,
                setAutoUpdater: () => {},
                getMainWindow: () => null,
            }),
        ),
    ];
};

describe('ipc channel manifest', () => {
    test('invoke surface set-equals the union of all handler-module channels', () => {
        const manifestSet = [...allInvokeChannels()].sort();
        const handlerSet = [...new Set(collectHandlerChannels())].sort();
        expect(manifestSet).toEqual(handlerSet);
    });

    test('sendMethods channels set-equal index.js direct ipcMain.on registrations', () => {
        // index.js pulls in the whole Electron app bootstrap, so its direct
        // registrations are read structurally instead of by requiring it.
        const src = fs.readFileSync(path.join(__dirname, '../../src/js/index.js'), 'utf8');
        const registered = [...src.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
        expect(Object.values(sendMethods).sort()).toEqual(registered);
    });

    test('no name collisions between generated methods, aliases, sends, and events', () => {
        const names = [
            ...invokeChannels.map(kebabToCamel),
            ...Object.keys(aliases),
            ...Object.keys(sendMethods),
            ...Object.keys(eventMethods),
        ];
        expect(new Set(names).size).toBe(names.length);
    });

    test('alias targets resolve to registered channels', () => {
        const handlerSet = new Set(collectHandlerChannels());
        for (const channel of Object.values(aliases)) {
            expect(handlerSet.has(channel)).toBe(true);
        }
    });
});
