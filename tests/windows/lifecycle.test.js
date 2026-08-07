// Mock electron so the lazy require inside ensureExit resolves to a
// controllable app object instead of Jest's node-env path string.
const mockApp = {
    exit: jest.fn(),
};

jest.mock('electron', () => ({
    app: mockApp,
}));

// Mock logger
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    })),
}));

const { focusExistingWindow, clearTokenOnQuit, FORCE_EXIT_GRACE_MS } = require('../../src/js/windows/lifecycle');

describe('ensureExit', () => {
    let ensureExit;
    let processExitSpy;

    beforeEach(() => {
        // The module keeps its pending timer in module-level state; a fresh
        // require per test keeps that state from bleeding across tests.
        jest.resetModules();
        ({ ensureExit } = require('../../src/js/windows/lifecycle'));
        jest.useFakeTimers();
        processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
        mockApp.exit.mockReset();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        processExitSpy.mockRestore();
    });

    test('calls app.exit(0) after the grace period, not process.exit', () => {
        ensureExit('test');

        expect(mockApp.exit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(FORCE_EXIT_GRACE_MS);

        expect(mockApp.exit).toHaveBeenCalledWith(0);
        expect(processExitSpy).not.toHaveBeenCalled();
    });

    test('falls back to process.exit(0) when app.exit throws', () => {
        mockApp.exit.mockImplementation(() => {
            throw new Error('electron torn down');
        });

        ensureExit('test');
        jest.advanceTimersByTime(FORCE_EXIT_GRACE_MS);

        expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    test('debounces: a second call resets the timer, single exit fires', () => {
        ensureExit('first');
        jest.advanceTimersByTime(1000);
        ensureExit('second');

        // The original deadline passes without firing.
        jest.advanceTimersByTime(FORCE_EXIT_GRACE_MS - 1000);
        expect(mockApp.exit).not.toHaveBeenCalled();

        // Full grace after the second call: exactly one exit.
        jest.advanceTimersByTime(1000);
        expect(mockApp.exit).toHaveBeenCalledTimes(1);
    });

    test('unrefs the timer so it cannot keep a clean shutdown alive', () => {
        jest.useRealTimers();
        const unref = jest.fn();
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue({ unref });

        ensureExit('test');

        expect(unref).toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
    });
});

describe('focusExistingWindow', () => {
    // Mirrors a real destroyed BrowserWindow: every method except
    // isDestroyed() throws, pinning the isDestroyed-first check order.
    const destroyedWindow = () => {
        const throwDestroyed = () => {
            throw new Error('Object has been destroyed');
        };
        return {
            isDestroyed: jest.fn(() => true),
            isMinimized: throwDestroyed,
            isVisible: throwDestroyed,
            restore: throwDestroyed,
            show: throwDestroyed,
            focus: throwDestroyed,
        };
    };

    const liveWindow = ({ minimized = false, visible = true } = {}) => ({
        isDestroyed: jest.fn(() => false),
        isMinimized: jest.fn(() => minimized),
        isVisible: jest.fn(() => visible),
        restore: jest.fn(),
        show: jest.fn(),
        focus: jest.fn(),
    });

    test('does nothing for null', () => {
        expect(() => focusExistingWindow(null)).not.toThrow();
    });

    test('does nothing for a destroyed window', () => {
        const win = destroyedWindow();

        expect(() => focusExistingWindow(win)).not.toThrow();
        expect(win.isDestroyed).toHaveBeenCalled();
    });

    test('restores and focuses a minimized window', () => {
        const win = liveWindow({ minimized: true });
        focusExistingWindow(win);

        expect(win.restore).toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        expect(win.focus).toHaveBeenCalled();
    });

    test('shows and focuses a hidden window', () => {
        const win = liveWindow({ visible: false });
        focusExistingWindow(win);

        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).toHaveBeenCalled();
        expect(win.focus).toHaveBeenCalled();
    });

    test('restores, shows, and focuses a window both minimized and hidden', () => {
        const win = liveWindow({ minimized: true, visible: false });
        focusExistingWindow(win);

        expect(win.restore).toHaveBeenCalled();
        expect(win.show).toHaveBeenCalled();
        expect(win.focus).toHaveBeenCalled();
    });

    test('only focuses a visible window', () => {
        const win = liveWindow();
        focusExistingWindow(win);

        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        expect(win.focus).toHaveBeenCalled();
    });
});

describe('clearTokenOnQuit', () => {
    const settingsFacade = (userSettings) => ({
        loadSettings: jest.fn(() => userSettings),
        setSetting: jest.fn(),
    });

    test('without the lock it never touches settings', () => {
        const facade = settingsFacade({ stayLoggedIn: false, token: 'abc' });
        clearTokenOnQuit(false, facade);

        expect(facade.loadSettings).not.toHaveBeenCalled();
        expect(facade.setSetting).not.toHaveBeenCalled();
    });

    test('with the lock, stayLoggedIn off and a token present, clears the token', () => {
        const facade = settingsFacade({ stayLoggedIn: false, token: 'abc' });
        clearTokenOnQuit(true, facade);

        expect(facade.setSetting).toHaveBeenCalledWith('token', '');
    });

    test('with stayLoggedIn on, keeps the token', () => {
        const facade = settingsFacade({ stayLoggedIn: true, token: 'abc' });
        clearTokenOnQuit(true, facade);

        expect(facade.setSetting).not.toHaveBeenCalled();
    });

    test('with no token, does not write', () => {
        const facade = settingsFacade({ stayLoggedIn: false, token: '' });
        clearTokenOnQuit(true, facade);

        expect(facade.setSetting).not.toHaveBeenCalled();
    });

    test('treats a missing stayLoggedIn key like false and clears the token', () => {
        const facade = settingsFacade({ token: 'abc' });
        clearTokenOnQuit(true, facade);

        expect(facade.setSetting).toHaveBeenCalledWith('token', '');
    });
});
