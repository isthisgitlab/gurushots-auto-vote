// @ts-check
import { appPath } from '../appPaths';
import { Menu, dialog, app, BrowserWindow } from 'electron';
import * as logger from '../logger';
import { translationManager } from '../translations/index';
import { AutoUpdater } from '../services/AutoUpdater';
import * as packageInfo from '../../../package.json';

/** @import { MenuItemConstructorOptions } from 'electron' */

/**
 * Application Menu Module
 * Handles creation and management of the native application menu
 */

// Translated text in the main process's current language.
/** @param {string} key */
const t = (key) => translationManager.t(key);

// Create application menu
function createApplicationMenu() {
    const isMac = process.platform === 'darwin';

    // Each conditional spread is typed on its own: the checker does not carry
    // the template's element type into a spread's array literal.
    /** @type {MenuItemConstructorOptions[]} */
    const template = [
        // macOS app menu
        ...(isMac
            ? /** @type {MenuItemConstructorOptions[]} */ ([
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
              ])
            : []),

        // Edit menu - essential for clipboard operations
        {
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
                    role: /** @type {MenuItemConstructorOptions['role']} */ (/** @type {string} */ ('selectall')),
                },
            ],
        },

        // File menu - simplified for this app
        ...(isMac
            ? []
            : /** @type {MenuItemConstructorOptions[]} */ ([
                  {
                      label: t('menu.file'),
                      submenu: [{ role: 'quit' }],
                  },
              ])),

        // View menu - relevant items for this app
        {
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
        },

        // Window menu - simplified
        {
            label: t('menu.window'),
            submenu: [
                {
                    label: t('menu.minimize'),
                    role: 'minimize',
                },
                ...(isMac
                    ? /** @type {MenuItemConstructorOptions[]} */ ([
                          {
                              label: t('menu.zoom'),
                              role: 'zoom',
                          },
                          { type: 'separator' },
                          {
                              label: t('menu.bringAllToFront'),
                              role: 'front',
                          },
                      ])
                    : /** @type {MenuItemConstructorOptions[]} */ ([
                          {
                              label: t('menu.close'),
                              role: 'close',
                          },
                      ])),
            ],
        },

        // Help menu
        {
            label: t('menu.help'),
            submenu: [
                {
                    label: t('menu.checkForUpdates'),
                    // Electron ignores the returned promise, which never rejects:
                    // checkForUpdatesFromMenu reports every failure itself.
                    click: /** @type {() => void} */ (() => checkForUpdatesFromMenu()),
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
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// Check for updates from menu
async function checkForUpdatesFromMenu() {
    try {
        // Get the main window to send events to
        const mainWindow = BrowserWindow.getAllWindows().find((win) => win.getTitle() !== 'Logs' && !win.isDestroyed());

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
            detail: /** @type {{ message?: string } | null | undefined} */ (error)?.message,
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
    // Check if logs window already exists
    const existingWindow = BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'Logs');
    if (existingWindow) {
        existingWindow.focus();
        return;
    }

    const logsWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'Logs',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // Same bundle as the main windows (scripts/build-react.js): the
            // sandboxed preload cannot require() the relative channel manifest,
            // so the raw src/js/preload.js would leave this window without window.api.
            preload: appPath('dist', 'preload-bundle.js'),
        },
        show: false,
    });

    logsWindow.loadFile(appPath('src', 'html', 'logs.html')).catch((error) => {
        logger.withCategory('ui').error('Failed to load logs window content:', error);
    });

    logsWindow.once('ready-to-show', () => {
        logsWindow.show();
    });
}

export { createApplicationMenu, updateMenuTranslations };
