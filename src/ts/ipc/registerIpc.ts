/**
 * The Electron shell's registration of every handler module on ipcMain, each through registerHandlers() so it
 * inherits the sender-frame and Logs-window checks. The order is the order the modules have always registered in.
 */

import * as actionsIpc from './actions.handlers';
import * as computationsIpc from './computations.handlers';
import * as currencyIpc from './currency.handlers';
import * as logIpc from './log.handlers';
import * as miscIpc from './misc.handlers';
import * as scenariosIpc from './scenarios.handlers';
import * as settingsIpc from './settings.handlers';
import * as updateIpc from './update.handlers';
import * as votingIpc from './voting.handlers';
import { registerHandlers } from './registerHandlers';

import type { IpcMain } from 'electron';
import type { GuiLogSink } from '../logger';

interface RegisterIpcDeps {
    update: Parameters<typeof updateIpc.buildHandlers>[0];
    misc: Parameters<typeof miscIpc.buildHandlers>[0];
}

const registerIpc = (ipcMain: IpcMain, deps: RegisterIpcDeps) => {
    registerHandlers(ipcMain, logIpc.buildHandlers());
    // logger.ts looks up this function via the global to push log
    // events from any module without a back-reference.
    (global as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = logIpc.sendLogToGUI;
    registerHandlers(ipcMain, updateIpc.buildHandlers(deps.update));
    registerHandlers(ipcMain, miscIpc.buildHandlers(deps.misc));
    registerHandlers(ipcMain, settingsIpc.buildHandlers());
    registerHandlers(ipcMain, votingIpc.buildHandlers());
    registerHandlers(ipcMain, actionsIpc.buildHandlers());
    registerHandlers(ipcMain, computationsIpc.buildHandlers());
    registerHandlers(ipcMain, currencyIpc.buildHandlers());
    registerHandlers(ipcMain, scenariosIpc.buildHandlers());
};

export { registerIpc };
