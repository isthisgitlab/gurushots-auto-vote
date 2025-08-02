const { Menu, dialog, app, BrowserWindow } = require('electron');

/**
 * Application Menu Module
 * Handles creation and management of the native application menu
 */

let translationManager = null;

// Initialize translation manager
function initializeTranslations() {
    if (global.translationManager) {
        translationManager = global.translationManager;
    }
}

// Get translated text
function t(key) {
    if (translationManager) {
        return translationManager.t(key);
    }
    return key;
}

// Create application menu
function createApplicationMenu() {
    // Initialize translations
    initializeTranslations();
    
    const isMac = process.platform === 'darwin';
    
    const template = [
        // macOS app menu
        ...(isMac ? [{
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
        }] : []),
        
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
                    role: 'selectall', 
                },
            ],
        },
        
        // File menu - simplified for this app
        ...(isMac ? [] : [{
            label: t('menu.file'),
            submenu: [
                { role: 'quit' },
            ],
        }]),
        
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
                ...(isMac ? [
                    { 
                        label: t('menu.zoom'),
                        role: 'zoom',
                    },
                    { type: 'separator' },
                    { 
                        label: t('menu.bringAllToFront'),
                        role: 'front',
                    },
                ] : [
                    { 
                        label: t('menu.close'),
                        role: 'close',
                    },
                ]),
            ],
        },
        
        // Help menu
        {
            label: t('menu.help'),
            submenu: [
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

// Show About dialog
function showAbout() {
    const packageInfo = require('../../../package.json');
    
    dialog.showMessageBox({
        type: 'info',
        title: t('menu.aboutTitle'),
        message: `${packageInfo.name} v${packageInfo.version}`,
        detail: `${t('menu.aboutDescription')}\n\n${t('menu.aboutAuthor')}: ${packageInfo.author.name}\n${t('menu.aboutElectron')}: ${process.versions.electron}\n${t('menu.aboutNode')}: ${process.versions.node}`,
        buttons: [t('common.ok')],
    });
}

// Update menu with current translations
function updateMenuTranslations() {
    // Re-initialize translations to get latest language
    initializeTranslations();
    // Recreate menu with new translations
    createApplicationMenu();
}

// Open logs window
function openLogsWindow() {
    const path = require('path');
    
    // Check if logs window already exists
    const existingWindow = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Logs');
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
            preload: path.join(__dirname, '../preload.js'),
        },
        show: false,
    });
    
    logsWindow.loadFile(path.join(__dirname, '../../html/logs.html'));
    
    logsWindow.once('ready-to-show', () => {
        logsWindow.show();
    });
    
    // Clean up when window is closed
    logsWindow.on('closed', () => {
        // Window will be garbage collected
    });
}

module.exports = {
    createApplicationMenu,
    updateMenuTranslations,
};