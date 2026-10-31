/**
 * registerIpc: every handler module reaches ipcMain through the guarded registerHandlers, in the order the
 * modules have always registered in, and the log module's fan-out hook is installed on the global the logger reads.
 */

import type * as registerIpcModule from '../../src/ts/shells/electron/registerIpc';
import type * as actions_handlersModule from '../../src/ts/core/ipc/actions.handlers';
import type * as computations_handlersModule from '../../src/ts/core/ipc/computations.handlers';
import type * as currency_handlersModule from '../../src/ts/core/ipc/currency.handlers';
import type * as log_handlersModule from '../../src/ts/core/ipc/log.handlers';
import type * as misc_handlersModule from '../../src/ts/shells/electron/misc.handlers';
import type * as scenarios_handlersModule from '../../src/ts/core/ipc/scenarios.handlers';
import type * as settings_handlersModule from '../../src/ts/core/ipc/settings.handlers';
import type * as update_handlersModule from '../../src/ts/shells/electron/update.handlers';
import type * as voting_handlersModule from '../../src/ts/core/ipc/voting.handlers';
import type { IpcMain } from 'electron';
import { invalid } from '../helpers/invalid';

jest.mock('electron', () => ({ shell: { openExternal: jest.fn() } }));
jest.mock('../../src/ts/shells/electron/AutoUpdater', () => ({ AutoUpdater: jest.fn() }));
jest.mock('../../src/ts/shells/electron/ui/applicationMenu', () => ({ updateMenuTranslations: jest.fn() }));

type ChannelImpl = Parameters<IpcMain['handle']>[1];

const { registerIpc } = require('../../src/ts/shells/electron/registerIpc') as typeof registerIpcModule;
const logIpc = require('../../src/ts/core/ipc/log.handlers') as typeof log_handlersModule;
const updateIpc = require('../../src/ts/shells/electron/update.handlers') as typeof update_handlersModule;
const miscIpc = require('../../src/ts/shells/electron/misc.handlers') as typeof misc_handlersModule;
const settingsIpc = require('../../src/ts/core/ipc/settings.handlers') as typeof settings_handlersModule;
const votingIpc = require('../../src/ts/core/ipc/voting.handlers') as typeof voting_handlersModule;
const actionsIpc = require('../../src/ts/core/ipc/actions.handlers') as typeof actions_handlersModule;
const computationsIpc = require('../../src/ts/core/ipc/computations.handlers') as typeof computations_handlersModule;
const currencyIpc = require('../../src/ts/core/ipc/currency.handlers') as typeof currency_handlersModule;
const scenariosIpc = require('../../src/ts/core/ipc/scenarios.handlers') as typeof scenarios_handlersModule;

const deps = {
    update: { getAutoUpdater: () => null, setAutoUpdater: jest.fn(), getMainWindow: () => null },
    misc: { getMainWindow: () => null, getLoginWindow: () => null },
};

describe('registerIpc', () => {
    test('registers the channels of every handler module, in module order', () => {
        const channels = new Map<string, ChannelImpl>();
        registerIpc(invalid({ handle: (channel: string, impl: ChannelImpl) => channels.set(channel, impl) }), deps);

        const expected = [
            logIpc.buildHandlers(),
            updateIpc.buildHandlers(deps.update),
            miscIpc.buildHandlers(deps.misc),
            settingsIpc.buildHandlers(),
            votingIpc.buildHandlers(),
            actionsIpc.buildHandlers(),
            computationsIpc.buildHandlers(),
            currencyIpc.buildHandlers(),
            scenariosIpc.buildHandlers(),
        ].flatMap((handlers) => Object.keys(handlers));
        expect([...channels.keys()]).toEqual(expected);
    });

    test('installs the log fan-out hook on the global the logger reads', () => {
        registerIpc(invalid({ handle: jest.fn() }), deps);
        expect((global as typeof globalThis & { sendLogToGUI?: unknown }).sendLogToGUI).toBe(logIpc.sendLogToGUI);
    });

    test('every channel goes through the sender-frame check', () => {
        const channels = new Map<string, ChannelImpl>();
        registerIpc(invalid({ handle: (channel: string, impl: ChannelImpl) => channels.set(channel, impl) }), deps);
        const frame = { url: 'https://evil.example/' };
        const event = invalid<Parameters<ChannelImpl>[0]>({ senderFrame: frame, sender: { mainFrame: frame } });
        for (const impl of channels.values()) {
            expect(impl(event)).toEqual({ success: false, error: 'Refused: untrusted sender' });
        }
    });
});
