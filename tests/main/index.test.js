/**
 * Electron main entry (src/js/index.js): single-instance lock, IPC module
 * wiring, window creation/bounds persistence, startup update-check ordering,
 * app lifecycle events, the quit-guard wiring and the login-success / logout
 * window swaps.
 *
 * Every collaborator is mocked; each test re-requires the entry point on a
 * fresh module registry (module-level window state lives in index.js).
 */

jest.mock('electron', () => {
    const appHandlers = {};
    const ipcHandlers = {};
    const powerHandlers = {};
    const windows = [];
    class BrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.handlers = {};
            this.onceHandlers = {};
            this.visible = false;
            this.destroyed = false;
            this.bounds = { x: 1, y: 2, width: 300, height: 400 };
            this.loadFile = jest.fn((file) => {
                this.file = file;
                return BrowserWindow.nextLoadResult ?? Promise.resolve();
            });
            this.on = jest.fn((ev, cb) => {
                this.handlers[ev] = cb;
            });
            this.once = jest.fn((ev, cb) => {
                this.onceHandlers[ev] = cb;
            });
            this.isVisible = jest.fn(() => this.visible);
            this.isDestroyed = jest.fn(() => this.destroyed);
            this.center = jest.fn();
            this.getBounds = jest.fn(() => this.bounds);
            this.close = jest.fn();
            this.focus = jest.fn();
            windows.push(this);
        }
        static getAllWindows() {
            return BrowserWindow.openWindows;
        }
    }
    BrowserWindow.instances = windows;
    BrowserWindow.openWindows = [];
    BrowserWindow.nextLoadResult = null;
    return {
        app: {
            handlers: appHandlers,
            commandLine: { appendSwitch: jest.fn() },
            requestSingleInstanceLock: jest.fn(() => true),
            quit: jest.fn(),
            show: jest.fn(),
            on: jest.fn((ev, cb) => {
                appHandlers[ev] = cb;
            }),
            whenReady: jest.fn(() => Promise.resolve()),
        },
        BrowserWindow,
        dialog: { showMessageBox: jest.fn() },
        powerMonitor: {
            handlers: powerHandlers,
            on: jest.fn((ev, cb) => {
                powerHandlers[ev] = cb;
            }),
        },
        ipcMain: {
            handlers: ipcHandlers,
            on: jest.fn((ch, cb) => {
                ipcHandlers[ch] = cb;
            }),
        },
    };
});

jest.mock('../../src/js/logger', () => {
    const cat = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { withCategory: jest.fn(() => cat), cleanup: jest.fn(), cat };
});

jest.mock('../../src/js/settings', () => ({
    getWindowBounds: jest.fn((kind) => ({ width: 800, height: 600, x: kind === 'main' ? 10 : 20, y: 30 })),
    saveWindowBounds: jest.fn(),
    loadSettings: jest.fn(() => ({})),
    getSetting: jest.fn(() => false),
    setSetting: jest.fn(),
    getUserDataPath: jest.fn(() => '/tmp/userData'),
    seedIntentProfiles: jest.fn(),
    getEnvironmentInfo: jest.fn(() => ({ defaultMock: true })),
}));

jest.mock('../../src/js/api/randomizer', () => ({ initializeHeaders: jest.fn() }));
jest.mock('../../src/js/services/AutoUpdater', () =>
    jest.fn().mockImplementation(() => ({
        checkForUpdates: jest.fn(() => Promise.resolve(null)),
        setMainWindow: jest.fn(),
    })),
);
jest.mock('../../src/js/services/auth', () => ({ clearAuthToken: jest.fn(() => Promise.resolve()) }));
for (const mod of ['log', 'update', 'misc', 'settings', 'voting', 'actions', 'computations', 'currency']) {
    jest.mock(`../../src/js/ipc/${mod}.handlers`, () => ({ register: jest.fn() }));
}
jest.mock('../../src/js/ipc/registerHandlers', () => ({ isTrustedSender: jest.fn(() => true) }));
jest.mock('../../src/js/windows/lifecycle', () => ({
    ensureExit: jest.fn(),
    focusExistingWindow: jest.fn(),
    clearTokenOnQuit: jest.fn(),
}));
jest.mock('../../src/js/windows/settingsWatcher', () => ({
    watchSettingsFile: jest.fn(() => ({ close: jest.fn() })),
}));
jest.mock('../../src/js/windows/backgroundActivity', () => ({ syncBackgroundActivity: jest.fn() }));
jest.mock('../../src/js/windows/quitGuard', () => ({
    holdQuitForOpenBoosts: jest.fn(() => false),
    bypassQuitGuard: jest.fn(),
    resetQuitGuard: jest.fn(),
}));
jest.mock('../../src/js/ui/applicationMenu', () => ({ createApplicationMenu: jest.fn() }));
jest.mock('../../src/js/translations/index', () => ({ translationManager: { t: (k) => k } }));

const originalPlatform = process.platform;
const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let m; // the freshly required mocks
let processHandlers;
let processOnSpy;

function load({ lock = true, whenReady } = {}) {
    jest.resetModules();
    const electron = require('electron');
    electron.app.requestSingleInstanceLock.mockReturnValue(lock);
    if (whenReady) electron.app.whenReady.mockImplementation(whenReady);
    m = {
        electron,
        app: electron.app,
        BrowserWindow: electron.BrowserWindow,
        ipcMain: electron.ipcMain,
        logger: require('../../src/js/logger'),
        settings: require('../../src/js/settings'),
        randomizer: require('../../src/js/api/randomizer'),
        AutoUpdater: require('../../src/js/services/AutoUpdater'),
        auth: require('../../src/js/services/auth'),
        updateIpc: require('../../src/js/ipc/update.handlers'),
        miscIpc: require('../../src/js/ipc/misc.handlers'),
        registerHandlers: require('../../src/js/ipc/registerHandlers'),
        lifecycle: require('../../src/js/windows/lifecycle'),
        watcher: require('../../src/js/windows/settingsWatcher'),
        bg: require('../../src/js/windows/backgroundActivity'),
        quitGuard: require('../../src/js/windows/quitGuard'),
        menu: require('../../src/js/ui/applicationMenu'),
    };
    m.cat = m.logger.cat;
    require('../../src/js/index');
    return m;
}

const windowFor = (file) => m.BrowserWindow.instances.filter((w) => w.file.endsWith(file)).at(-1);
const loginWin = () => windowFor('login.html');
const mainWin = () => windowFor('app.html');
const autoUpdaterInstance = () => m.AutoUpdater.mock.results.at(-1).value;

beforeEach(() => {
    // The no-session startup path arms a 3s update-check timer; keep it fake so
    // no real timer outlives a test. setImmediate stays real for flush().
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    processHandlers = {};
    const realOn = process.on.bind(process);
    processOnSpy = jest.spyOn(process, 'on').mockImplementation((ev, cb) => {
        if (['SIGINT', 'SIGTERM', 'exit'].includes(ev)) {
            processHandlers[ev] = cb;
            return process;
        }
        return realOn(ev, cb);
    });
});

afterEach(() => {
    processOnSpy.mockRestore();
    setPlatform(originalPlatform);
    jest.useRealTimers();
});

describe('module bootstrap', () => {
    it('disables service workers and the real keychain, and wires every IPC module', async () => {
        load();
        expect(global.translationManager).toBeUndefined();
        expect(m.app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-features', 'ServiceWorker');
        expect(m.app.commandLine.appendSwitch).toHaveBeenCalledWith('use-mock-keychain');
        for (const mod of ['log', 'update', 'misc', 'settings', 'voting', 'actions', 'computations', 'currency']) {
            expect(require(`../../src/js/ipc/${mod}.handlers`).register.mock.calls[0][0]).toBe(m.ipcMain);
        }
        expect(Object.keys(m.ipcMain.handlers)).toEqual(['login-success', 'logout']);
        await flush();
    });

    it('exposes live window / updater accessors to the update and misc IPC modules', async () => {
        load();
        await flush();
        const updateDeps = m.updateIpc.register.mock.calls[0][1];
        const miscDeps = m.miscIpc.register.mock.calls[0][1];

        expect(updateDeps.getAutoUpdater()).toBe(autoUpdaterInstance());
        const replacement = { setMainWindow: jest.fn() };
        updateDeps.setAutoUpdater(replacement);
        expect(updateDeps.getAutoUpdater()).toBe(replacement);

        expect(miscDeps.getLoginWindow()).toBe(loginWin());
        expect(miscDeps.getMainWindow()).toBeNull();
        m.ipcMain.handlers['login-success']({});
        expect(updateDeps.getMainWindow()).toBe(mainWin());
        expect(miscDeps.getMainWindow()).toBe(mainWin());
        // The replaced updater (not the original) is handed the new window.
        expect(replacement.setMainWindow).toHaveBeenCalledWith(mainWin());
        expect(autoUpdaterInstance().setMainWindow).not.toHaveBeenCalled();
    });

    it('a losing second instance quits and never boots or registers second-instance', async () => {
        load({ lock: false });
        await flush();

        expect(m.cat.info).toHaveBeenCalledWith('Another instance is already running — exiting this one.', null);
        expect(m.app.quit).toHaveBeenCalled();
        expect(m.app.whenReady).not.toHaveBeenCalled();
        expect(m.app.handlers['second-instance']).toBeUndefined();

        // before-quit is still registered, but told there is no lock.
        m.app.handlers['before-quit']({ preventDefault: jest.fn() });
        expect(m.lifecycle.clearTokenOnQuit).toHaveBeenCalledWith(false, m.settings);
        // Nor does it ask about boosts — that would read the primary's settings.json.
        expect(m.quitGuard.holdQuitForOpenBoosts).not.toHaveBeenCalled();
    });
});

describe('startup (whenReady)', () => {
    it('without a saved session: boots, shows the login window, then checks for updates after 3s', async () => {
        load();
        await flush();

        expect(m.cat.info).toHaveBeenCalledWith('[App] UserData path: /tmp/userData', null);
        expect(m.randomizer.initializeHeaders).toHaveBeenCalled();
        expect(m.settings.seedIntentProfiles).toHaveBeenCalled();
        expect(m.logger.cleanup).toHaveBeenCalled();
        expect(m.menu.createApplicationMenu).toHaveBeenCalled();
        expect(m.AutoUpdater).toHaveBeenCalledWith();
        expect(loginWin()).toBeDefined();
        expect(mainWin()).toBeUndefined();

        const updater = autoUpdaterInstance();
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        jest.advanceTimersByTime(2999);
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(updater.checkForUpdates).toHaveBeenCalledWith(false);
    });

    it('with a saved session: checks for updates BEFORE creating the main window', async () => {
        let resolveCheck;
        // Prime the fresh registry's mocks before the entry point runs.
        jest.resetModules();
        const settings = require('../../src/js/settings');
        settings.loadSettings.mockReturnValue({ token: 't', stayLoggedIn: true });
        const AU = require('../../src/js/services/AutoUpdater');
        const check = jest.fn(
            () =>
                new Promise((r) => {
                    resolveCheck = r;
                }),
        );
        AU.mockImplementation(() => ({ checkForUpdates: check, setMainWindow: jest.fn() }));
        const electron = require('electron');
        require('../../src/js/index');
        await flush();

        expect(check).toHaveBeenCalledWith(false);
        const created = () => electron.BrowserWindow.instances.map((w) => w.file);
        expect(created()).toEqual([]);

        resolveCheck(null);
        await flush();
        expect(created()).toHaveLength(1);
        expect(created()[0]).toMatch(/app\.html$/);
    });

    it('logs (and survives) a failing update check and a failing intent seed', async () => {
        jest.resetModules();
        const settings = require('../../src/js/settings');
        settings.loadSettings.mockReturnValue({ token: 't', stayLoggedIn: true });
        const seedErr = new Error('seed');
        settings.seedIntentProfiles.mockImplementation(() => {
            throw seedErr;
        });
        const checkErr = new Error('offline');
        require('../../src/js/services/AutoUpdater').mockImplementation(() => ({
            checkForUpdates: jest.fn(() => Promise.reject(checkErr)),
            setMainWindow: jest.fn(),
        }));
        const { cat } = require('../../src/js/logger');
        const electron = require('electron');
        require('../../src/js/index');
        await flush();

        expect(cat.warning).toHaveBeenCalledWith('Intent profile seeding failed (non-fatal):', seedErr);
        expect(cat.error).toHaveBeenCalledWith('Error during update check:', checkErr);
        expect(electron.BrowserWindow.instances.at(-1).file).toMatch(/app\.html$/);
    });

    it('logs a bootstrap failure instead of letting it vanish', async () => {
        jest.resetModules();
        const boom = new Error('no userData');
        require('../../src/js/settings').getUserDataPath.mockImplementation(() => {
            throw boom;
        });
        const { cat } = require('../../src/js/logger');
        require('../../src/js/index');
        await flush();

        expect(cat.error).toHaveBeenCalledWith('Startup failed:', boom);
    });

    it('activate re-creates a window only when none are open', async () => {
        load();
        await flush();
        const before = m.BrowserWindow.instances.length;

        m.BrowserWindow.openWindows = [loginWin()];
        m.app.handlers.activate();
        expect(m.BrowserWindow.instances).toHaveLength(before);

        m.BrowserWindow.openWindows = [];
        m.app.handlers.activate();
        expect(m.BrowserWindow.instances).toHaveLength(before + 1);
        expect(loginWin().opts.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false });
    });

    it('SIGINT / SIGTERM quit and force exit; exit logs the code', async () => {
        load();
        await flush();

        processHandlers.SIGINT();
        expect(m.cat.info).toHaveBeenCalledWith('Received SIGINT signal. Exiting...', null);
        expect(m.lifecycle.ensureExit).toHaveBeenCalledWith('SIGINT');

        processHandlers.SIGTERM();
        expect(m.cat.info).toHaveBeenCalledWith('Received SIGTERM signal. Exiting...', null);
        expect(m.lifecycle.ensureExit).toHaveBeenCalledWith('SIGTERM');
        expect(m.app.quit).toHaveBeenCalledTimes(2);
        // A signal is not the user's quit to confirm.
        expect(m.quitGuard.bypassQuitGuard).toHaveBeenCalledTimes(2);
        expect(m.quitGuard.bypassQuitGuard.mock.invocationCallOrder[0]).toBeLessThan(
            m.app.quit.mock.invocationCallOrder[0],
        );

        processHandlers.exit(3);
        expect(m.cat.info).toHaveBeenCalledWith('Process exiting with code: 3', null);
    });
});

describe('quit guard wiring', () => {
    beforeEach(async () => {
        load();
        await flush();
    });

    it('an OS shutdown bypasses the guard', () => {
        expect(m.electron.powerMonitor.handlers.shutdown).toBe(m.quitGuard.bypassQuitGuard);
    });

    it('before-quit asks first; a held quit neither clears the token nor force-exits', () => {
        m.ipcMain.handlers['login-success']({});
        m.settings.getSetting.mockImplementation((key) => key === 'autovoteRunning');
        m.quitGuard.holdQuitForOpenBoosts.mockReturnValueOnce(true);
        const event = { preventDefault: jest.fn() };

        m.app.handlers['before-quit'](event);

        const [heldEvent, deps] = m.quitGuard.holdQuitForOpenBoosts.mock.calls[0];
        expect(heldEvent).toBe(event);
        expect(deps).toMatchObject({ autovoteRunning: true, dialog: m.electron.dialog, parent: mainWin() });
        expect(deps.t('quitGuard.title')).toBe('quitGuard.title');
        expect(m.lifecycle.clearTokenOnQuit).not.toHaveBeenCalled();
        expect(m.lifecycle.ensureExit).not.toHaveBeenCalled();

        deps.proceed();
        expect(m.app.quit).toHaveBeenCalled();
    });

    it('closing the main window asks first, re-closes on confirm, and resets the guard once closed', () => {
        m.ipcMain.handlers['login-success']({});
        const win = mainWin();
        const event = { preventDefault: jest.fn() };

        win.handlers.close(event);
        const [heldEvent, deps] = m.quitGuard.holdQuitForOpenBoosts.mock.calls[0];
        expect(heldEvent).toBe(event);
        expect(deps.autovoteRunning).toBe(false);

        deps.proceed();
        expect(win.close).toHaveBeenCalledTimes(1);
        win.destroyed = true;
        deps.proceed();
        expect(win.close).toHaveBeenCalledTimes(1);

        expect(win.handlers['query-session-end']).toBe(m.quitGuard.bypassQuitGuard);

        win.handlers.closed();
        expect(m.quitGuard.resetQuitGuard).toHaveBeenCalled();
    });
});

describe('login window', () => {
    beforeEach(async () => {
        load();
        await flush();
    });

    it('is created from saved bounds with an isolated, sandboxed-preload webPreferences', () => {
        const win = loginWin();
        expect(m.settings.getWindowBounds).toHaveBeenCalledWith('login');
        expect(win.opts).toMatchObject({ width: 800, height: 600, x: 20, y: 30 });
        expect(win.opts.webPreferences).toMatchObject({
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            partition: 'persist:gurushots',
        });
        expect(win.opts.webPreferences.preload).toMatch(/preload-bundle\.js$/);
    });

    it('centers only when not already visible on ready-to-show', () => {
        const win = loginWin();
        win.visible = true;
        win.onceHandlers['ready-to-show']();
        expect(win.center).not.toHaveBeenCalled();
        win.visible = false;
        win.onceHandlers['ready-to-show']();
        expect(win.center).toHaveBeenCalledTimes(1);
    });

    it('persists bounds on resize and move, and forgets the window when closed', () => {
        const win = loginWin();
        win.handlers.resize();
        win.bounds = { x: 5, y: 6, width: 7, height: 8 };
        win.handlers.move();
        expect(m.settings.saveWindowBounds.mock.calls).toEqual([
            ['login', { x: 1, y: 2, width: 300, height: 400 }],
            ['login', { x: 5, y: 6, width: 7, height: 8 }],
        ]);

        win.handlers.closed();
        expect(m.miscIpc.register.mock.calls[0][1].getLoginWindow()).toBeNull();
    });

    it('logs when the login page fails to load', async () => {
        const err = new Error('missing');
        m.BrowserWindow.nextLoadResult = Promise.reject(err);
        m.BrowserWindow.openWindows = [];
        m.app.handlers.activate();
        await flush();
        expect(m.cat.error).toHaveBeenCalledWith('Failed to load login window content:', err);
    });
});

describe('main window', () => {
    it('is created without an updater when login succeeds before startup finishes', () => {
        load({ whenReady: () => new Promise(() => {}) });
        m.ipcMain.handlers['login-success']({});
        expect(mainWin()).toBeDefined();
        expect(m.AutoUpdater).not.toHaveBeenCalled();
    });

    describe('after startup', () => {
        beforeEach(async () => {
            load();
            await flush();
            m.settings.getSetting.mockReturnValue(true);
            m.ipcMain.handlers['login-success']({});
        });

        it('hands the window to the updater and adopts the persisted autovote flag', () => {
            const win = mainWin();
            expect(autoUpdaterInstance().setMainWindow).toHaveBeenCalledWith(win);
            expect(m.settings.getWindowBounds).toHaveBeenCalledWith('main');
            expect(win.opts).toMatchObject({ x: 10 });
            expect(win.opts.webPreferences.backgroundThrottling).toBe(false);
            expect(m.settings.getSetting).toHaveBeenCalledWith('autovoteRunning');
            expect(m.bg.syncBackgroundActivity).toHaveBeenLastCalledWith(true);
            expect(m.cat.warning).not.toHaveBeenCalled();
        });

        it('centers when hidden on ready-to-show and persists bounds on resize/move', () => {
            const win = mainWin();
            win.visible = true;
            win.onceHandlers['ready-to-show']();
            expect(win.center).not.toHaveBeenCalled();
            win.visible = false;
            win.onceHandlers['ready-to-show']();
            expect(win.center).toHaveBeenCalled();

            win.handlers.resize();
            win.handlers.move();
            expect(m.settings.saveWindowBounds).toHaveBeenCalledTimes(2);
            expect(m.settings.saveWindowBounds).toHaveBeenCalledWith('main', win.bounds);
        });

        it('passes live window state to the settings watcher and follows autovote changes', () => {
            const deps = m.watcher.watchSettingsFile.mock.calls[0][0];
            const win = mainWin();
            expect(deps.getMainWindow()).toBe(win);
            expect(typeof deps.getMainWindowCreatedTime()).toBe('number');

            m.bg.syncBackgroundActivity.mockClear();
            deps.onSettingsChanged({ autovoteRunning: true });
            deps.onSettingsChanged({ autovoteRunning: 'yes' });
            expect(m.bg.syncBackgroundActivity.mock.calls).toEqual([[true], [false]]);

            win.destroyed = true;
            deps.onSettingsChanged({ autovoteRunning: true });
            expect(m.bg.syncBackgroundActivity).toHaveBeenCalledTimes(2);
        });

        it('on close: releases the watcher and the background assertion, and ignores late callbacks', () => {
            const deps = m.watcher.watchSettingsFile.mock.calls[0][0];
            const watcher = m.watcher.watchSettingsFile.mock.results[0].value;
            m.bg.syncBackgroundActivity.mockClear();

            mainWin().handlers.closed();

            expect(watcher.close).toHaveBeenCalled();
            expect(m.bg.syncBackgroundActivity).toHaveBeenCalledWith(false);
            expect(deps.getMainWindow()).toBeNull();

            deps.onSettingsChanged({ autovoteRunning: true });
            expect(m.bg.syncBackgroundActivity).toHaveBeenCalledTimes(1);
        });

        it('logs when the app page fails to load', async () => {
            const err = new Error('bad html');
            m.BrowserWindow.nextLoadResult = Promise.reject(err);
            m.ipcMain.handlers['login-success']({});
            await flush();
            expect(m.cat.error).toHaveBeenCalledWith('Failed to load main window content:', err);
        });
    });

    it('warns when there is no settings watcher and still closes cleanly', async () => {
        load();
        await flush();
        m.watcher.watchSettingsFile.mockReturnValue(null);
        m.ipcMain.handlers['login-success']({});

        expect(m.bg.syncBackgroundActivity).toHaveBeenLastCalledWith(false);
        expect(m.cat.warning).toHaveBeenCalledWith(expect.stringContaining('No settings watcher'));

        m.bg.syncBackgroundActivity.mockClear();
        mainWin().handlers.closed();
        expect(m.bg.syncBackgroundActivity).toHaveBeenCalledWith(false);
    });
});

describe('app events', () => {
    beforeEach(async () => {
        load();
        await flush();
    });

    it('second-instance focuses the main window, else the login window, and un-hides on macOS', () => {
        setPlatform('darwin');
        m.app.handlers['second-instance']();
        expect(m.cat.info).toHaveBeenCalledWith('Second instance launch blocked — focusing existing window.', null);
        expect(m.app.show).toHaveBeenCalled();
        expect(m.lifecycle.focusExistingWindow).toHaveBeenLastCalledWith(loginWin());

        setPlatform('linux');
        m.app.show.mockClear();
        m.ipcMain.handlers['login-success']({});
        m.app.handlers['second-instance']();
        expect(m.app.show).not.toHaveBeenCalled();
        expect(m.lifecycle.focusExistingWindow).toHaveBeenLastCalledWith(mainWin());
    });

    it('second-instance with no window yet just logs and passes null', () => {
        setPlatform('linux');
        loginWin().handlers.closed();
        m.app.handlers['second-instance']();
        expect(m.cat.info).toHaveBeenCalledWith(
            'Second instance launch blocked — no window to focus yet (still starting up).',
            null,
        );
        expect(m.lifecycle.focusExistingWindow).toHaveBeenCalledWith(null);
    });

    it('before-quit clears the token (with the lock) and always force-exits, even if clearing throws', () => {
        m.app.handlers['before-quit']();
        expect(m.lifecycle.clearTokenOnQuit).toHaveBeenCalledWith(true, m.settings);
        expect(m.lifecycle.ensureExit).toHaveBeenCalledWith('before-quit');

        const err = new Error('disk full');
        m.lifecycle.clearTokenOnQuit.mockImplementation(() => {
            throw err;
        });
        m.lifecycle.ensureExit.mockClear();
        m.app.handlers['before-quit']();
        expect(m.cat.error).toHaveBeenCalledWith('Failed to clear token on quit:', err);
        expect(m.lifecycle.ensureExit).toHaveBeenCalledWith('before-quit');
    });

    it('window-all-closed quits everywhere except macOS', () => {
        setPlatform('darwin');
        m.app.handlers['window-all-closed']();
        expect(m.app.quit).not.toHaveBeenCalled();
        expect(m.lifecycle.ensureExit).not.toHaveBeenCalled();

        setPlatform('win32');
        m.app.handlers['window-all-closed']();
        expect(m.app.quit).toHaveBeenCalled();
        expect(m.lifecycle.ensureExit).toHaveBeenCalledWith('window-all-closed');
    });
});

describe('login-success IPC', () => {
    beforeEach(async () => {
        load();
        await flush();
    });

    it('refuses untrusted senders', () => {
        m.registerHandlers.isTrustedSender.mockReturnValue(false);
        m.ipcMain.handlers['login-success']({ untrusted: true });
        expect(m.cat.warning).toHaveBeenCalledWith("Refused IPC 'login-success' from untrusted frame", null);
        expect(mainWin()).toBeUndefined();
    });

    it('closes the login window (if any) and opens the main window', () => {
        const login = loginWin();
        m.ipcMain.handlers['login-success']({});
        expect(login.close).toHaveBeenCalled();
        expect(mainWin()).toBeDefined();

        login.handlers.closed();
        m.ipcMain.handlers['login-success']({});
        expect(m.BrowserWindow.instances.filter((w) => w.file.endsWith('app.html'))).toHaveLength(2);
    });
});

describe('logout IPC', () => {
    beforeEach(async () => {
        load();
        await flush();
    });

    it('refuses untrusted senders', () => {
        m.registerHandlers.isTrustedSender.mockReturnValue(false);
        m.ipcMain.handlers.logout({});
        expect(m.cat.warning).toHaveBeenCalledWith("Refused IPC 'logout' from untrusted frame", null);
        expect(m.auth.clearAuthToken).not.toHaveBeenCalled();
    });

    it('does nothing without a main window', () => {
        m.ipcMain.handlers.logout({});
        expect(m.auth.clearAuthToken).not.toHaveBeenCalled();
    });

    it('clears the token, resets mock, then swaps to the existing login window after the main window closes', async () => {
        m.ipcMain.handlers['login-success']({});
        const main = mainWin();
        const login = loginWin();

        m.ipcMain.handlers.logout({});
        await flush();

        expect(m.auth.clearAuthToken).toHaveBeenCalled();
        expect(m.settings.setSetting).toHaveBeenCalledWith('mock', true);
        // Logging out is its own confirmation — no boost prompt on the way out.
        expect(m.quitGuard.bypassQuitGuard).toHaveBeenCalled();
        expect(main.close).toHaveBeenCalled();
        expect(login.focus).not.toHaveBeenCalled();

        main.onceHandlers.closed();
        expect(login.focus).toHaveBeenCalled();
    });

    it('creates a fresh login window after close when none exists, and logs a failed token clear', async () => {
        m.ipcMain.handlers['login-success']({});
        loginWin().handlers.closed();
        const err = new Error('flush failed');
        m.auth.clearAuthToken.mockRejectedValue(err);
        const loginsBefore = m.BrowserWindow.instances.filter((w) => w.file.endsWith('login.html')).length;

        m.ipcMain.handlers.logout({});
        await flush();

        expect(m.cat.error).toHaveBeenCalledWith('Logout failed to clear token', err);
        mainWin().onceHandlers.closed();
        expect(m.BrowserWindow.instances.filter((w) => w.file.endsWith('login.html'))).toHaveLength(loginsBefore + 1);
    });

    it('if the main window was destroyed mid-logout, focuses the existing login window', async () => {
        m.ipcMain.handlers['login-success']({});
        const main = mainWin();
        main.destroyed = true;

        m.ipcMain.handlers.logout({});
        await flush();

        expect(main.close).not.toHaveBeenCalled();
        expect(loginWin().focus).toHaveBeenCalled();
    });

    it('if the main window closed mid-logout with no login window, opens a new login window', async () => {
        m.ipcMain.handlers['login-success']({});
        loginWin().handlers.closed();
        let release;
        m.auth.clearAuthToken.mockImplementation(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        const loginsBefore = m.BrowserWindow.instances.filter((w) => w.file.endsWith('login.html')).length;

        m.ipcMain.handlers.logout({});
        mainWin().handlers.closed();
        release();
        await flush();

        expect(m.BrowserWindow.instances.filter((w) => w.file.endsWith('login.html'))).toHaveLength(loginsBefore + 1);
    });
});
