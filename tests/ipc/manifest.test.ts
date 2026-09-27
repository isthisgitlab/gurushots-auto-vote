/**
 * Channel-manifest drift test — the enforcement half of R4's "a new channel
 * can't silently miss one platform" guarantee.
 *
 * Asserts set-equality between the manifest's invoke surface
 * (invokeChannels ∪ alias targets) and the union of every
 * ipc/*.handlers.ts buildHandlers() key, and between the manifest's
 * sendMethods channels and index.ts's direct ipcMain.on registrations
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
import pathModule = require('path');
const path = jest.mocked(pathModule);
import type * as manifestModule from '../../src/js/ipc/manifest';
import type * as settings_handlersModule from '../../src/js/ipc/settings.handlers';
import type * as voting_handlersModule from '../../src/js/ipc/voting.handlers';
import type * as log_handlersModule from '../../src/js/ipc/log.handlers';
import type * as actions_handlersModule from '../../src/js/ipc/actions.handlers';
import type * as computations_handlersModule from '../../src/js/ipc/computations.handlers';
import type * as currency_handlersModule from '../../src/js/ipc/currency.handlers';
import type * as scenarios_handlersModule from '../../src/js/ipc/scenarios.handlers';
import type * as misc_handlersModule from '../../src/js/ipc/misc.handlers';
import type * as update_handlersModule from '../../src/js/ipc/update.handlers';

const {
    invokeChannels,
    aliases,
    sendMethods,
    eventMethods,
    kebabToCamel,
    allInvokeChannels,
}: typeof manifestModule = require('../../src/js/ipc/manifest');

const collectHandlerChannels = () => {
    const settingsHandlers: typeof settings_handlersModule = require('../../src/js/ipc/settings.handlers');
    const votingHandlers: typeof voting_handlersModule = require('../../src/js/ipc/voting.handlers');
    const logHandlers: typeof log_handlersModule = require('../../src/js/ipc/log.handlers');
    const actionsHandlers: typeof actions_handlersModule = require('../../src/js/ipc/actions.handlers');
    const computationsHandlers: typeof computations_handlersModule = require('../../src/js/ipc/computations.handlers');
    const currencyHandlers: typeof currency_handlersModule = require('../../src/js/ipc/currency.handlers');
    const scenariosHandlers: typeof scenarios_handlersModule = require('../../src/js/ipc/scenarios.handlers');
    const miscHandlers: typeof misc_handlersModule = require('../../src/js/ipc/misc.handlers');
    const updateHandlers: typeof update_handlersModule = require('../../src/js/ipc/update.handlers');

    return [
        ...Object.keys(settingsHandlers.buildHandlers({ broadcastSettingsChange: () => {} })),
        ...Object.keys(votingHandlers.buildHandlers()),
        ...Object.keys(logHandlers.buildHandlers()),
        ...Object.keys(actionsHandlers.buildHandlers()),
        ...Object.keys(computationsHandlers.buildHandlers()),
        ...Object.keys(currencyHandlers.buildHandlers()),
        ...Object.keys(scenariosHandlers.buildHandlers()),
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

    test('sendMethods channels set-equal index.ts direct ipcMain.on registrations', () => {
        // index.ts pulls in the whole Electron app bootstrap, so its direct
        // registrations are read structurally instead of by requiring it.
        const src = fs.readFileSync(path.join(__dirname, '../../src/js/index.ts'), 'utf8');
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
