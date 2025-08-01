const { Menu, dialog, app } = require('electron');

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

// Get translated text with fallback
function t(key, fallback = key) {
    if (translationManager) {
        return translationManager.t(key);
    }
    return fallback;
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
        
        // File menu - simplified for this app
        ...(isMac ? [] : [{
            label: t('menu.file', 'File'),
            submenu: [
                { role: 'quit' },
            ],
        }]),
        
        // View menu - relevant items for this app
        {
            label: t('menu.view', 'View'),
            submenu: [
                { 
                    label: t('menu.reload', 'Reload'),
                    role: 'reload',
                },
                { 
                    label: t('menu.toggleDevTools', 'Toggle Developer Tools'),
                    role: 'toggleDevTools',
                },
                { type: 'separator' },
                { 
                    label: t('menu.toggleFullscreen', 'Toggle Fullscreen'),
                    role: 'togglefullscreen',
                },
            ],
        },
        
        // Window menu - simplified
        {
            label: t('menu.window', 'Window'),
            submenu: [
                { 
                    label: t('menu.minimize', 'Minimize'),
                    role: 'minimize',
                },
                ...(isMac ? [
                    { 
                        label: t('menu.zoom', 'Zoom'),
                        role: 'zoom',
                    },
                    { type: 'separator' },
                    { 
                        label: t('menu.bringAllToFront', 'Bring All to Front'),
                        role: 'front',
                    },
                ] : [
                    { 
                        label: t('menu.close', 'Close'),
                        role: 'close',
                    },
                ]),
            ],
        },
        
        // Help menu
        {
            label: t('menu.help', 'Help'),
            submenu: [
                {
                    label: t('menu.about', 'About GuruShots Auto Vote'),
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
        title: t('menu.aboutTitle', 'About GuruShots Auto Vote'),
        message: `${packageInfo.name} v${packageInfo.version}`,
        detail: `${t('menu.aboutDescription', packageInfo.description)}\n\n${t('menu.aboutAuthor', 'Author')}: ${packageInfo.author.name}\n${t('menu.aboutElectron', 'Electron')}: ${process.versions.electron}\n${t('menu.aboutNode', 'Node.js')}: ${process.versions.node}`,
        buttons: [t('common.ok', 'OK')],
    });
}

// Update menu with current translations
function updateMenuTranslations() {
    // Re-initialize translations to get latest language
    initializeTranslations();
    // Recreate menu with new translations
    createApplicationMenu();
}

module.exports = {
    createApplicationMenu,
    updateMenuTranslations,
};