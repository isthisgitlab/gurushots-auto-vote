/**
 * Native application menu (src/js/ui/applicationMenu.js): template shape per
 * platform, translation lookup, and the Help-menu click actions (update check,
 * logs window, about dialog). Electron and AutoUpdater are mocked.
 */

const mockAutoUpdaterCheck = jest.fn();
const mockAutoUpdaterCtor = jest.fn();

jest.mock('electron', () => {
    const windows = [];
    class BrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.handlers = {};
            this.loadFile = jest.fn(() => BrowserWindow.nextLoadResult ?? Promise.resolve());
            this.once = jest.fn((ev, cb) => {
                this.handlers[ev] = cb;
            });
            this.show = jest.fn();
            this.focus = jest.fn();
            this.getTitle = () => opts.title;
            this.isDestroyed = () => false;
            BrowserWindow.created.push(this);
        }
        static getAllWindows() {
            return windows;
        }
    }
    BrowserWindow.created = [];
    BrowserWindow.windows = windows;
    BrowserWindow.nextLoadResult = null;
    return {
        Menu: { buildFromTemplate: jest.fn((tpl) => ({ tpl })), setApplicationMenu: jest.fn() },
        dialog: { showMessageBox: jest.fn(() => Promise.resolve({ response: 0 })) },
        app: { getName: jest.fn(() => 'GuruShots Auto Voter') },
        BrowserWindow,
    };
});

jest.mock('../../src/js/services/AutoUpdater', () =>
    jest.fn().mockImplementation((win) => {
        mockAutoUpdaterCtor(win);
        return { checkForUpdates: mockAutoUpdaterCheck };
    }),
);

let electron;
let logger;
const packageInfo = require('../../package.json');

const originalPlatform = process.platform;
const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

let menuModule;

function loadMenu() {
    jest.resetModules();
    electron = require('electron');
    logger = require('../../src/js/logger');
    menuModule = require('../../src/js/ui/applicationMenu');
}

function builtTemplate() {
    const calls = electron.Menu.buildFromTemplate.mock.calls;
    return calls[calls.length - 1][0];
}

function helpItem(label) {
    const help = builtTemplate().find((m) => m.label === 'menu.help');
    return help.submenu.find((i) => i.label === label);
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    jest.clearAllMocks();
    delete global.translationManager;
    loadMenu();
});

afterEach(() => {
    setPlatform(originalPlatform);
    delete global.translationManager;
});

describe('createApplicationMenu', () => {
    it('builds the macOS template with the app menu, zoom/front and no File menu', () => {
        setPlatform('darwin');
        menuModule.createApplicationMenu();

        const tpl = builtTemplate();
        expect(tpl[0].label).toBe('GuruShots Auto Voter');
        expect(tpl[0].submenu.map((i) => i.role).filter(Boolean)).toEqual([
            'about',
            'services',
            'hide',
            'hideOthers',
            'unhide',
            'quit',
        ]);
        expect(tpl.map((m) => m.label)).toEqual([
            'GuruShots Auto Voter',
            'menu.edit',
            'menu.view',
            'menu.window',
            'menu.help',
        ]);
        const windowMenu = tpl.find((m) => m.label === 'menu.window');
        expect(windowMenu.submenu.map((i) => i.role).filter(Boolean)).toEqual(['minimize', 'zoom', 'front']);
        expect(electron.Menu.setApplicationMenu).toHaveBeenCalledWith({ tpl });
    });

    it('builds the non-mac template with a File menu and a Close item', () => {
        setPlatform('linux');
        menuModule.createApplicationMenu();

        const tpl = builtTemplate();
        expect(electron.app.getName).not.toHaveBeenCalled();
        expect(tpl.map((m) => m.label)).toEqual(['menu.edit', 'menu.file', 'menu.view', 'menu.window', 'menu.help']);
        expect(tpl[1].submenu).toEqual([{ role: 'quit' }]);
        const windowMenu = tpl.find((m) => m.label === 'menu.window');
        expect(windowMenu.submenu.map((i) => i.role)).toEqual(['minimize', 'close']);
        expect(tpl[0].submenu.map((i) => i.role).filter(Boolean)).toEqual([
            'undo',
            'redo',
            'cut',
            'copy',
            'paste',
            'selectall',
        ]);
    });

    it('uses the global translation manager when one is present', () => {
        global.translationManager = { t: jest.fn((k) => `T(${k})`) };
        menuModule.createApplicationMenu();

        const labels = builtTemplate().map((m) => m.label);
        expect(labels).toContain('T(menu.edit)');
        expect(labels).toContain('T(menu.help)');
        expect(global.translationManager.t).toHaveBeenCalledWith('menu.checkForUpdates');
    });

    it('updateMenuTranslations picks up a translation manager set later and rebuilds', () => {
        menuModule.createApplicationMenu();
        expect(builtTemplate().map((m) => m.label)).toContain('menu.edit');

        global.translationManager = { t: (k) => `LV:${k}` };
        menuModule.updateMenuTranslations();

        expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
        expect(builtTemplate().map((m) => m.label)).toContain('LV:menu.edit');
    });
});

describe('Help → Check for Updates', () => {
    beforeEach(() => menuModule.createApplicationMenu());

    it('passes the first live non-Logs window to AutoUpdater and logs when an update exists', async () => {
        const logsWin = { getTitle: () => 'Logs', isDestroyed: () => false };
        const deadWin = { getTitle: () => 'Main', isDestroyed: () => true };
        const mainWin = { getTitle: () => 'Main', isDestroyed: () => false };
        electron.BrowserWindow.windows.push(logsWin, deadWin, mainWin);
        mockAutoUpdaterCheck.mockResolvedValue({ latestVersion: '9.9.9' });
        const info = jest.fn();
        const spy = logger.withCategory.mockReturnValue({ info, error: jest.fn() });

        await helpItem('menu.checkForUpdates').click();

        expect(mockAutoUpdaterCtor).toHaveBeenCalledWith(mainWin);
        expect(mockAutoUpdaterCheck).toHaveBeenCalledWith(true);
        expect(spy).toHaveBeenCalledWith('update');
        expect(info).toHaveBeenCalledWith('Update available from menu check:', '9.9.9');
        expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('shows the "no updates" dialog when the check returns nothing', async () => {
        mockAutoUpdaterCheck.mockResolvedValue(null);

        await helpItem('menu.checkForUpdates').click();

        expect(mockAutoUpdaterCtor).toHaveBeenCalledWith(undefined);
        expect(electron.dialog.showMessageBox).toHaveBeenCalledWith({
            type: 'info',
            title: 'menu.noUpdates',
            message: 'menu.noUpdatesMessage',
            buttons: ['common.ok'],
        });
    });

    it('logs and shows an error dialog when the check throws', async () => {
        const err = new Error('network down');
        mockAutoUpdaterCheck.mockRejectedValue(err);
        const error = jest.fn();
        logger.withCategory.mockReturnValue({ info: jest.fn(), error });

        await helpItem('menu.checkForUpdates').click();

        expect(error).toHaveBeenCalledWith('Error checking for updates from menu:', err);
        expect(electron.dialog.showMessageBox).toHaveBeenCalledWith({
            type: 'error',
            title: 'menu.updateError',
            message: 'menu.updateErrorMessage',
            detail: 'network down',
            buttons: ['common.ok'],
        });
    });
});

describe('Help → About', () => {
    it('shows name, version, author and runtime versions', () => {
        menuModule.createApplicationMenu();
        helpItem('menu.about').click();

        const arg = electron.dialog.showMessageBox.mock.calls[0][0];
        expect(arg.type).toBe('info');
        expect(arg.title).toBe('menu.aboutTitle');
        expect(arg.message).toBe(`${packageInfo.name} v${packageInfo.version}`);
        expect(arg.detail).toContain(`menu.aboutAuthor: ${packageInfo.author.name}`);
        expect(arg.detail).toContain(`menu.aboutNode: ${process.versions.node}`);
        expect(arg.buttons).toEqual(['common.ok']);
    });
});

describe('Help → Logs', () => {
    beforeEach(() => menuModule.createApplicationMenu());

    it('focuses an existing Logs window instead of opening another', () => {
        const existing = { getTitle: () => 'Logs', focus: jest.fn() };
        electron.BrowserWindow.windows.push({ getTitle: () => 'Main' }, existing);

        helpItem('menu.logs').click();

        expect(existing.focus).toHaveBeenCalled();
        expect(electron.BrowserWindow.created).toHaveLength(0);
    });

    it('opens a hidden, isolated Logs window and shows it once ready', async () => {
        helpItem('menu.logs').click();

        expect(electron.BrowserWindow.created).toHaveLength(1);
        const win = electron.BrowserWindow.created[0];
        expect(win.opts).toMatchObject({
            title: 'Logs',
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        expect(win.loadFile.mock.calls[0][0]).toMatch(/html[/\\]logs\.html$/);
        expect(win.show).not.toHaveBeenCalled();
        win.handlers['ready-to-show']();
        expect(win.show).toHaveBeenCalled();
    });

    it('logs when the Logs window content fails to load', async () => {
        const err = new Error('ENOENT');
        electron.BrowserWindow.nextLoadResult = Promise.reject(err);
        const error = jest.fn();
        const spy = logger.withCategory.mockReturnValue({ info: jest.fn(), error });

        helpItem('menu.logs').click();
        await flush();

        expect(spy).toHaveBeenCalledWith('ui');
        expect(error).toHaveBeenCalledWith('Failed to load logs window content:', err);
    });
});
