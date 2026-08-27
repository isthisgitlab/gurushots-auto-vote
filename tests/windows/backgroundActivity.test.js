/**
 * Tests for the auto-vote power-save blocker
 * (src/js/windows/backgroundActivity.js).
 *
 * The module's whole job is to keep a held assertion in step with the running
 * flag without ever throwing at its callers, so these tests pin three things:
 * it holds exactly one assertion while running, it releases on stop, and every
 * Electron failure mode degrades to "no blocker" rather than an exception on
 * the window-creation / settings-change path.
 */

const mockPowerSaveBlocker = {
    start: jest.fn(),
    stop: jest.fn(),
    isStarted: jest.fn(),
};

jest.mock('electron', () => ({
    powerSaveBlocker: mockPowerSaveBlocker,
}));

jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    })),
}));

describe('syncBackgroundActivity', () => {
    let syncBackgroundActivity;

    beforeEach(() => {
        // The held id is module-level state; a fresh require per test keeps it
        // from bleeding across cases.
        jest.resetModules();
        jest.clearAllMocks();
        mockPowerSaveBlocker.start.mockReturnValue(7);
        mockPowerSaveBlocker.isStarted.mockReturnValue(true);
        ({ syncBackgroundActivity } = require('../../src/js/windows/backgroundActivity'));
    });

    test('starts prevent-app-suspension when auto-vote starts running', () => {
        expect(syncBackgroundActivity(true)).toBe(true);
        expect(mockPowerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
        expect(mockPowerSaveBlocker.start).toHaveBeenCalledTimes(1);
    });

    test('never asks for the display — only CPU time', () => {
        syncBackgroundActivity(true);
        expect(mockPowerSaveBlocker.start).not.toHaveBeenCalledWith('prevent-display-sleep');
    });

    test('is idempotent while running — one assertion, not one per settings write', () => {
        syncBackgroundActivity(true);
        syncBackgroundActivity(true);
        syncBackgroundActivity(true);
        expect(mockPowerSaveBlocker.start).toHaveBeenCalledTimes(1);
    });

    test('stopping before anything was ever started is a no-op', () => {
        expect(syncBackgroundActivity(false)).toBe(false);
        expect(mockPowerSaveBlocker.stop).not.toHaveBeenCalled();
        expect(mockPowerSaveBlocker.start).not.toHaveBeenCalled();
    });

    test('releases the assertion when auto-vote stops', () => {
        syncBackgroundActivity(true);
        expect(syncBackgroundActivity(false)).toBe(false);
        expect(mockPowerSaveBlocker.stop).toHaveBeenCalledWith(7);
    });

    test('stopping twice does not re-stop a released id', () => {
        syncBackgroundActivity(true);
        syncBackgroundActivity(false);
        syncBackgroundActivity(false);
        expect(mockPowerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    });

    test('a stale id (Electron ended the blocker itself) is re-started, not trusted', () => {
        syncBackgroundActivity(true);
        // Electron dropped it out from under us — believing the old id would
        // leave the app nappable while we think it is protected.
        mockPowerSaveBlocker.isStarted.mockReturnValue(false);
        mockPowerSaveBlocker.start.mockReturnValue(9);

        expect(syncBackgroundActivity(true)).toBe(true);
        expect(mockPowerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    test('a stale id is not stopped again on release', () => {
        syncBackgroundActivity(true);
        mockPowerSaveBlocker.isStarted.mockReturnValue(false);

        expect(syncBackgroundActivity(false)).toBe(false);
        expect(mockPowerSaveBlocker.stop).not.toHaveBeenCalled();
    });

    test('a throwing start degrades to "no blocker" instead of breaking the caller', () => {
        mockPowerSaveBlocker.start.mockImplementation(() => {
            throw new Error('power API unavailable');
        });

        expect(() => syncBackgroundActivity(true)).not.toThrow();
        expect(syncBackgroundActivity(true)).toBe(false);
    });

    test('after a throwing start, a later sync retries from a clean slate', () => {
        mockPowerSaveBlocker.start.mockImplementationOnce(() => {
            throw new Error('power API unavailable');
        });
        syncBackgroundActivity(true);

        mockPowerSaveBlocker.start.mockReturnValue(11);
        expect(syncBackgroundActivity(true)).toBe(true);
        expect(mockPowerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    test('a throwing stop still forgets the id so the next start is clean', () => {
        syncBackgroundActivity(true);
        mockPowerSaveBlocker.stop.mockImplementation(() => {
            throw new Error('already gone');
        });

        expect(() => syncBackgroundActivity(false)).not.toThrow();

        mockPowerSaveBlocker.stop.mockImplementation(() => {});
        mockPowerSaveBlocker.start.mockReturnValue(13);
        expect(syncBackgroundActivity(true)).toBe(true);
    });
});
