import { appPath } from '../appPaths';
import { Menu, dialog, app, BrowserWindow } from 'electron';
import * as logger from '../logger';
import { translationManager } from '../translations/index';
import { AutoUpdater } from '../services/AutoUpdater';
import { appState } from '../index/state';
import * as packageInfo from '../../../package.json';

import type { MenuItemConstructorOptions } from 'electron';
import { errorMessage } from '../errorMessage';

/**
 * Application Menu Module
 * Handles creation and management of the native application menu
 */

// Translated text in the main process's current language.
const t = (key: string) => translationManager.t(key);

// The platform-conditional menu parts are functions with their own return type,
// spread in by the template; windowMenu's inline conditional spread is cast to
// its element type instead, because the checker does not carry the template's
// element type into a spread's array literal.
const macAppMenu = (): MenuItemConstructorOptions[] => [
    {
        label: app.getName(),
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
        ],
    },
];

// Essential for clipboard operations
const editMenu = (): MenuItemConstructorOptions => ({
    label: t('menu.edit'),
    submenu: [
        {
            label: t('menu.undo'),
            role: 'undo',
        },
        {
            label: t('menu.redo'),
            role: 'redo',
        },
        { type: 'separator' },
        {
            label: t('menu.cut'),
            role: 'cut',
        },
        {
            label: t('menu.copy'),
            role: 'copy',
        },
        {
            label: t('menu.paste'),
            role: 'paste',
        },
        {
            label: t('menu.selectAll'),
            // Electron lower-cases a role before looking it up; its typings
            // spell this one only as 'selectAll'.
            role: 'selectall' as string as MenuItemConstructorOptions['role'],
        },
    ],
});

const fileMenu = (): MenuItemConstructorOptions[] => [
    {
        label: t('menu.file'),
        submenu: [{ role: 'quit' }],
    },
];

const viewMenu = (): MenuItemConstructorOptions => ({
    label: t('menu.view'),
    submenu: [
        {
            label: t('menu.reload'),
            role: 'reload',
        },
        {
            label: t('menu.toggleDevTools'),
            role: 'toggleDevTools',
        },
        { type: 'separator' },
        {
            label: t('menu.toggleFullscreen'),
            role: 'togglefullscreen',
        },
    ],
});

const windowMenu = (isMac: boolean): MenuItemConstructorOptions => ({
    label: t('menu.window'),
    submenu: [
        {
            label: t('menu.minimize'),
            role: 'minimize',
        },
        ...(isMac
            ? ([
                  {
                      label: t('menu.zoom'),
                      role: 'zoom',
                  },
                  { type: 'separator' },
                  {
                      label: t('menu.bringAllToFront'),
                      role: 'front',
                  },
              ] as MenuItemConstructorOptions[])
            : ([
                  {
                      label: t('menu.close'),
                      role: 'close',
                  },
              ] as MenuItemConstructorOptions[])),
    ],
});

const helpMenu = (): MenuItemConstructorOptions => ({
    label: t('menu.help'),
    submenu: [
        {
            label: t('menu.checkForUpdates'),
            // Electron ignores the returned promise, which never rejects:
            // checkForUpdatesFromMenu reports every failure itself.
            click: (() => checkForUpdatesFromMenu()) as () => void,
        },
        { type: 'separator' },
        {
            label: t('menu.logs'),
            click: () => openLogsWindow(),
        },
        { type: 'separator' },
        {
            label: t('menu.about'),
            click: () => showAbout(),
        },
    ],
});

function createApplicationMenu() {
    const isMac = process.platform === 'darwin';

    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? macAppMenu() : []),
        editMenu(),
        ...(isMac ? [] : fileMenu()),
        viewMenu(),
        windowMenu(isMac),
        helpMenu(),
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// The open Logs window; cleared when it closes.
let logsWindow: BrowserWindow | null = null;

// Check for updates from menu
async function checkForUpdatesFromMenu() {
    try {
        // The window update events go to: the main window, or the login window before login.
        const target = appState.mainWindow ?? appState.loginWindow;
        const mainWindow = target && !target.isDestroyed() ? target : undefined;

        const autoUpdater = new AutoUpdater(mainWindow);
        const updateInfo = await autoUpdater.checkForUpdates(true); // Force check

        if (updateInfo) {
            // Update is available - the autoUpdater will send event to renderer
            logger.withCategory('update').info('Update available from menu check:', updateInfo.latestVersion);
        } else {
            // No update available - show dialog
            void dialog.showMessageBox({
                type: 'info',
                title: t('menu.noUpdates'),
                message: t('menu.noUpdatesMessage'),
                buttons: [t('common.ok')],
            });
        }
    } catch (error) {
        logger.withCategory('update').error('Error checking for updates from menu:', error);
        void dialog.showMessageBox({
            type: 'error',
            title: t('menu.updateError'),
            message: t('menu.updateErrorMessage'),
            detail: errorMessage(error),
            buttons: [t('common.ok')],
        });
    }
}

// Show About dialog
function showAbout() {
    void dialog.showMessageBox({
        type: 'info',
        title: t('menu.aboutTitle'),
        message: `${packageInfo.name} v${packageInfo.version}`,
        detail: `${t('menu.aboutDescription')}\n\n${t('menu.aboutAuthor')}: ${packageInfo.author.name}\n${t('menu.aboutElectron')}: ${process.versions.electron}\n${t('menu.aboutNode')}: ${process.versions.node}`,
        buttons: [t('common.ok')],
    });
}

// Rebuild the menu in the translation manager's current language
function updateMenuTranslations() {
    createApplicationMenu();
}

// Open logs window
function openLogsWindow() {
    if (logsWindow) {
        logsWindow.focus();
        return;
    }

    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'Logs',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            // Same bundle as the main windows (scripts/build-react.ts): the
            // sandboxed preload cannot require() the relative channel manifest,
            // so the raw src/ts/preload.ts would leave this window without window.api.
            preload: appPath('dist', 'preload-bundle.js'),
        },
        show: false,
    });
    logsWindow = win;
    win.on('closed', () => {
        if (logsWindow === win) logsWindow = null;
    });

    win.loadFile(appPath('src', 'html', 'logs.html')).catch((error) => {
        logger.withCategory('ui').error('Failed to load logs window content:', error);
    });

    win.once('ready-to-show', () => {
        win.show();
    });
}

export { createApplicationMenu, updateMenuTranslations };
