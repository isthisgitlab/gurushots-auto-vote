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
jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory', () => ({
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
    refreshApi: jest.fn(),
}));
jest.mock('../../src/ts/ui/applicationMenu', () => ({
    updateMenuTranslations: jest.fn(),
}));

const fs = jest.requireActual<typeof import('fs')>('fs');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import type * as manifestModule from '../../src/ts/ipc/manifest';
import type * as settings_handlersModule from '../../src/ts/ipc/settings.handlers';
import type * as voting_handlersModule from '../../src/ts/ipc/voting.handlers';
import type * as log_handlersModule from '../../src/ts/ipc/log.handlers';
import type * as actions_handlersModule from '../../src/ts/ipc/actions.handlers';
import type * as computations_handlersModule from '../../src/ts/ipc/computations.handlers';
import type * as currency_handlersModule from '../../src/ts/ipc/currency.handlers';
import type * as scenarios_handlersModule from '../../src/ts/ipc/scenarios.handlers';
import type * as misc_handlersModule from '../../src/ts/ipc/misc.handlers';
import type * as update_handlersModule from '../../src/ts/ipc/update.handlers';

const { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel, allInvokeChannels } =
    require('../../src/ts/ipc/manifest') as typeof manifestModule;

const collectHandlerChannels = () => {
    const settingsHandlers = require('../../src/ts/ipc/settings.handlers') as typeof settings_handlersModule;
    const votingHandlers = require('../../src/ts/ipc/voting.handlers') as typeof voting_handlersModule;
    const logHandlers = require('../../src/ts/ipc/log.handlers') as typeof log_handlersModule;
    const actionsHandlers = require('../../src/ts/ipc/actions.handlers') as typeof actions_handlersModule;
    const computationsHandlers =
        require('../../src/ts/ipc/computations.handlers') as typeof computations_handlersModule;
    const currencyHandlers = require('../../src/ts/ipc/currency.handlers') as typeof currency_handlersModule;
    const scenariosHandlers = require('../../src/ts/ipc/scenarios.handlers') as typeof scenarios_handlersModule;
    const miscHandlers = require('../../src/ts/ipc/misc.handlers') as typeof misc_handlersModule;
    const updateHandlers = require('../../src/ts/ipc/update.handlers') as typeof update_handlersModule;

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
        const src = fs.readFileSync(path.join(__dirname, '../../src/ts/index.ts'), 'utf8');
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
