/**
 * Native application menu (src/ts/ui/applicationMenu.ts): template shape per
 * platform, translation lookup, and the Help-menu click actions (update check,
 * logs window, about dialog). Electron and AutoUpdater are mocked.
 */

import type { BrowserWindowConstructorOptions, MessageBoxOptions } from 'electron';
import type * as LoggerModule from '../../src/ts/logger';
import type * as MenuModule from '../../src/ts/ui/applicationMenu';
import type * as StateModule from '../../src/ts/index/state';
import { invalid } from '../helpers/invalid';

/** The mocked electron's view of a menu template entry (what the tests read back). */
type MenuEntry = { label?: string; role?: string; submenu?: MenuEntry[]; click?: () => unknown };
/** A window constructed through the mocked `new BrowserWindow(...)`. */
type CreatedWindow = {
    opts: BrowserWindowConstructorOptions;
    handlers: Record<string, () => void>;
    loadFile: jest.Mock<Promise<void>, [string]>;
    focus: jest.Mock<void, []>;
    show: jest.Mock<void, []>;
};
/** Shape of the `electron` mock factory below. */
type ElectronMock = {
    Menu: {
        buildFromTemplate: jest.Mock<{ tpl: MenuEntry[] }, [MenuEntry[]]>;
        setApplicationMenu: jest.Mock<void, [{ tpl: MenuEntry[] } | null]>;
    };
    dialog: { showMessageBox: jest.Mock<Promise<{ response: number }>, [MessageBoxOptions]> };
    app: { getName: jest.Mock<string, []> };
    BrowserWindow: { created: CreatedWindow[]; nextLoadResult: Promise<void> | null };
};

const mockAutoUpdaterCheck = jest.fn();
const mockAutoUpdaterCtor = jest.fn();

jest.mock('electron', () => {
    class BrowserWindow {
        declare opts: BrowserWindowConstructorOptions;
        declare handlers: Record<string, () => void>;
        declare loadFile: jest.Mock<Promise<void>, [string]>;
        declare on: jest.Mock<void, [string, () => void]>;
        declare once: jest.Mock<void, [string, () => void]>;
        declare show: jest.Mock<void, []>;
        declare focus: jest.Mock<void, []>;
        declare isDestroyed: () => boolean;
        declare static created: BrowserWindow[];
        declare static nextLoadResult: Promise<void> | null;
        constructor(opts: BrowserWindowConstructorOptions) {
            this.opts = opts;
            this.handlers = {};
            this.loadFile = jest.fn<Promise<void>, [string]>(() => BrowserWindow.nextLoadResult ?? Promise.resolve());
            this.on = jest.fn((ev, cb) => {
                this.handlers[ev] = cb;
            });
            this.once = jest.fn((ev, cb) => {
                this.handlers[ev] = cb;
            });
            this.show = jest.fn<void, []>();
            this.focus = jest.fn<void, []>();
            this.isDestroyed = () => false;
            BrowserWindow.created.push(this);
        }
    }
    BrowserWindow.created = [];
    BrowserWindow.nextLoadResult = null;
    return {
        Menu: { buildFromTemplate: jest.fn((tpl: MenuEntry[]) => ({ tpl })), setApplicationMenu: jest.fn() },
        dialog: { showMessageBox: jest.fn(() => Promise.resolve({ response: 0 })) },
        app: { getName: jest.fn(() => 'GuruShots Auto Voter') },
        BrowserWindow,
    };
});

// The menu reads the Node translation manager's current language; a test
// swaps `translate` to simulate a language switch.
const mockTranslation = { translate: (k: string): string => k };
jest.mock('../../src/ts/translations/index', () => ({
    translationManager: { t: (k: string) => mockTranslation.translate(k) },
}));

jest.mock('../../src/ts/services/AutoUpdater', () => ({
    AutoUpdater: jest.fn().mockImplementation((win) => {
        mockAutoUpdaterCtor(win);
        return { checkForUpdates: mockAutoUpdaterCheck };
    }),
}));

let electron: ElectronMock;
let logger: jest.MockedObject<typeof LoggerModule>;
import packageInfo = require('../../package.json');

const originalPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

let menuModule: typeof MenuModule;
let appState: typeof StateModule.appState;
/** A window as the update check sees it: only `isDestroyed` is read. */
const listedWindow = (destroyed = false) =>
    invalid<NonNullable<typeof appState.mainWindow>>({ isDestroyed: () => destroyed });

function loadMenu() {
    jest.resetModules();
    electron = require('electron') as typeof electron;
    logger = jest.mocked(require('../../src/ts/logger') as typeof LoggerModule);
    menuModule = require('../../src/ts/ui/applicationMenu') as typeof menuModule;
    appState = (require('../../src/ts/index/state') as typeof StateModule).appState;
}

function builtTemplate() {
    const calls = electron.Menu.buildFromTemplate.mock.calls;
    return calls[calls.length - 1][0];
}

function helpItem(label: string) {
    const help = builtTemplate().find((m) => m.label === 'menu.help');
    return help!.submenu!.find((i) => i.label === label)!;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    jest.clearAllMocks();
    mockTranslation.translate = (k) => k;
    loadMenu();
});

afterEach(() => {
    setPlatform(originalPlatform);
});

describe('createApplicationMenu', () => {
    it('builds the macOS template with the app menu, zoom/front and no File menu', () => {
        setPlatform('darwin');
        menuModule.createApplicationMenu();

        const tpl = builtTemplate();
        expect(tpl[0].label).toBe('GuruShots Auto Voter');
        expect(tpl[0].submenu!.map((i) => i.role).filter(Boolean)).toEqual([
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
        expect(windowMenu!.submenu!.map((i) => i.role).filter(Boolean)).toEqual(['minimize', 'zoom', 'front']);
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
        expect(windowMenu!.submenu!.map((i) => i.role)).toEqual(['minimize', 'close']);
        expect(tpl[0].submenu!.map((i) => i.role).filter(Boolean)).toEqual([
            'undo',
            'redo',
            'cut',
            'copy',
            'paste',
            'selectall',
        ]);
    });

    it('labels the menu through the translation manager', () => {
        mockTranslation.translate = jest.fn((k) => `T(${k})`);
        menuModule.createApplicationMenu();

        const labels = builtTemplate().map((m) => m.label);
        expect(labels).toContain('T(menu.edit)');
        expect(labels).toContain('T(menu.help)');
        expect(mockTranslation.translate).toHaveBeenCalledWith('menu.checkForUpdates');
    });

    it('updateMenuTranslations rebuilds the menu in the current language', () => {
        menuModule.createApplicationMenu();
        expect(builtTemplate().map((m) => m.label)).toContain('menu.edit');

        mockTranslation.translate = (k) => `LV:${k}`;
        menuModule.updateMenuTranslations();

        expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
        expect(builtTemplate().map((m) => m.label)).toContain('LV:menu.edit');
    });
});

describe('Help → Check for Updates', () => {
    beforeEach(() => menuModule.createApplicationMenu());

    it('passes the main window to AutoUpdater and logs when an update exists', async () => {
        const mainWin = listedWindow();
        appState.mainWindow = mainWin;
        appState.loginWindow = listedWindow();
        mockAutoUpdaterCheck.mockResolvedValue({ latestVersion: '9.9.9' });
        const info = jest.fn();
        const spy = logger.withCategory.mockReturnValue(invalid({ info, error: jest.fn() }));

        await helpItem('menu.checkForUpdates').click!();

        expect(mockAutoUpdaterCtor).toHaveBeenCalledWith(mainWin);
        expect(mockAutoUpdaterCheck).toHaveBeenCalledWith(true);
        expect(spy).toHaveBeenCalledWith('update');
        expect(info).toHaveBeenCalledWith('Update available from menu check:', '9.9.9');
        expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('falls back to the login window when there is no main window', async () => {
        const loginWin = listedWindow();
        appState.loginWindow = loginWin;
        mockAutoUpdaterCheck.mockResolvedValue(null);

        await helpItem('menu.checkForUpdates').click!();

        expect(mockAutoUpdaterCtor).toHaveBeenCalledWith(loginWin);
    });

    it('never targets a destroyed window, nor the Logs window', async () => {
        appState.mainWindow = listedWindow(true);
        mockAutoUpdaterCheck.mockResolvedValue(null);
        helpItem('menu.logs').click!();

        await helpItem('menu.checkForUpdates').click!();

        expect(mockAutoUpdaterCtor).toHaveBeenCalledWith(undefined);
    });

    it('shows the "no updates" dialog when the check returns nothing', async () => {
        mockAutoUpdaterCheck.mockResolvedValue(null);

        await helpItem('menu.checkForUpdates').click!();

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
        logger.withCategory.mockReturnValue(invalid({ info: jest.fn(), error }));

        await helpItem('menu.checkForUpdates').click!();

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
        helpItem('menu.about').click!();

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

    it('focuses the open Logs window instead of opening another', () => {
        helpItem('menu.logs').click!();
        helpItem('menu.logs').click!();

        expect(electron.BrowserWindow.created).toHaveLength(1);
        expect(electron.BrowserWindow.created[0].focus).toHaveBeenCalledTimes(1);
    });

    it('opens a new Logs window once the previous one has closed', () => {
        helpItem('menu.logs').click!();
        electron.BrowserWindow.created[0].handlers['closed']();
        helpItem('menu.logs').click!();

        expect(electron.BrowserWindow.created).toHaveLength(2);
    });

    it("keeps a stale window's 'closed' from clearing the current Logs window", () => {
        helpItem('menu.logs').click!();
        const first = electron.BrowserWindow.created[0];
        first.handlers['closed']();
        helpItem('menu.logs').click!();
        first.handlers['closed']();
        helpItem('menu.logs').click!();

        expect(electron.BrowserWindow.created).toHaveLength(2);
    });

    it('opens a hidden, sandboxed, isolated Logs window and shows it once ready', async () => {
        helpItem('menu.logs').click!();

        expect(electron.BrowserWindow.created).toHaveLength(1);
        const win = electron.BrowserWindow.created[0];
        expect(win.opts).toMatchObject({
            title: 'Logs',
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
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
        const spy = logger.withCategory.mockReturnValue(invalid({ info: jest.fn(), error }));

        helpItem('menu.logs').click!();
        await flush();

        expect(spy).toHaveBeenCalledWith('ui');
        expect(error).toHaveBeenCalledWith('Failed to load logs window content:', err);
    });
});
