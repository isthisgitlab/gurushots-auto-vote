/**
 * The Electron shell's registration of every handler module on ipcMain, each through registerHandlers() so it
 * inherits the sender-frame and Logs-window checks. The order is the order the modules have always registered in.
 */

import { app } from 'electron';
import * as logger from '../../core/logger';
import * as actionsIpc from '../../core/ipc/actions.handlers';
import * as computationsIpc from '../../core/ipc/computations.handlers';
import * as currencyIpc from '../../core/ipc/currency.handlers';
import * as logIpc from '../../core/ipc/log.handlers';
import * as miscIpc from './misc.handlers';
import * as scenariosIpc from '../../core/ipc/scenarios.handlers';
import * as settingsIpc from '../../core/ipc/settings.handlers';
import * as updateIpc from './update.handlers';
import * as votingIpc from '../../core/ipc/voting.handlers';
import { registerHandlers } from './registerHandlers';
import { createRemotePairing } from './remote/pairing';

import type { IpcMain } from 'electron';
import type { GuiLogSink } from '../../core/logger';

interface RegisterIpcDeps {
    update: Parameters<typeof updateIpc.buildHandlers>[0];
    misc: Omit<Parameters<typeof miscIpc.buildHandlers>[0], 'remote'>;
}

const registerIpc = (ipcMain: IpcMain, deps: RegisterIpcDeps) => {
    registerHandlers(ipcMain, logIpc.buildHandlers());
    // logger.ts looks up this function via the global to push log
    // events from any module without a back-reference.
    (global as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = logIpc.sendLogToGUI;
    registerHandlers(ipcMain, updateIpc.buildHandlers(deps.update));
    registerHandlers(
        ipcMain,
        miscIpc.buildHandlers({
            ...deps.misc,
            remote: createRemotePairing({
                isPackaged: () => app.isPackaged,
                argv: process.argv,
                warn: (message) => logger.withCategory('ui').warning(message, null),
            }),
        }),
    );
    registerHandlers(ipcMain, settingsIpc.buildHandlers());
    registerHandlers(ipcMain, votingIpc.buildHandlers());
    registerHandlers(ipcMain, actionsIpc.buildHandlers());
    registerHandlers(ipcMain, computationsIpc.buildHandlers());
    registerHandlers(ipcMain, currencyIpc.buildHandlers());
    registerHandlers(ipcMain, scenariosIpc.buildHandlers());
};

export { registerIpc };
