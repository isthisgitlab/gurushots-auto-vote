/**
 * clearAuthToken — the shared logout core every shell routes through.
 *
 * The load-bearing guarantee is Capacitor's: settings writes go through a
 * write-behind cache, so logout MUST await flushPendingWrites before
 * resolving or an OS kill right after logout can leave the old token
 * persisted and silently restore the session on next launch. This suite
 * simulates that write-behind store and asserts the persisted (not just
 * cached) token is gone by the time clearAuthToken resolves.
 */

jest.mock('../../src/js/settings', () => {
    const state = {
        cached: { token: 'old-token' },
        persisted: { token: 'old-token' },
        flushCalls: 0,
    };
    return {
        __state: state,
        getSetting: jest.fn((key) => state.cached[key]),
        setSetting: jest.fn((key, value) => {
            // Write-behind: only the in-memory cache updates synchronously.
            state.cached[key] = value;
        }),
        flushPendingWrites: jest.fn(async () => {
            // The async flush is what actually persists.
            state.flushCalls++;
            state.persisted = { ...state.cached };
        }),
    };
});

const settings = require('../../src/js/settings');
const { clearAuthToken } = require('../../src/js/services/auth');

describe('clearAuthToken', () => {
    beforeEach(() => {
        settings.__state.cached = { token: 'old-token' };
        settings.__state.persisted = { token: 'old-token' };
        settings.__state.flushCalls = 0;
        jest.clearAllMocks();
    });

    it('durably persists the cleared token before resolving (Capacitor kill-safety)', async () => {
        const hadToken = await clearAuthToken();

        expect(hadToken).toBe(true);
        // Not just the cache — the simulated backing store must be clean.
        expect(settings.__state.persisted.token).toBe('');
        expect(settings.flushPendingWrites).toHaveBeenCalledTimes(1);
    });

    it('flushes after the clear write, never before', async () => {
        const order = [];
        settings.setSetting.mockImplementation((key, value) => {
            order.push('set');
            settings.__state.cached[key] = value;
        });
        settings.flushPendingWrites.mockImplementation(async () => {
            order.push('flush');
            settings.__state.persisted = { ...settings.__state.cached };
        });

        await clearAuthToken();

        expect(order).toEqual(['set', 'flush']);
    });

    it('reports false when no token was set', async () => {
        settings.__state.cached = { token: '' };
        expect(await clearAuthToken()).toBe(false);
    });

    it('tolerates hosts without flushPendingWrites (Electron/CLI sync writes)', async () => {
        settings.flushPendingWrites = undefined;
        await expect(clearAuthToken()).resolves.toBe(true);
        expect(settings.__state.cached.token).toBe('');
    });
});

/**
 * stayLoggedIn used to be honoured only by the Electron quit path, so a CLI or Android user
 * who turned it off still kept a token on disk indefinitely — the opposite of what the
 * setting promises. The rule now lives with the rest of the auth core so every shell can
 * apply it; the Electron single-instance gate stays in windows/lifecycle.js because that part
 * really is Electron-specific.
 */
describe('clearTokenUnlessStayingLoggedIn', () => {
    const { clearTokenUnlessStayingLoggedIn } = require('../../src/js/services/auth');

    beforeEach(() => {
        settings.__state.cached = { token: 'old-token', stayLoggedIn: false };
        settings.__state.persisted = { token: 'old-token' };
        settings.flushPendingWrites = jest.fn(async () => {
            settings.__state.persisted = { ...settings.__state.cached };
        });
    });

    it('clears the token when stayLoggedIn is off', async () => {
        await expect(clearTokenUnlessStayingLoggedIn()).resolves.toBe(true);
        expect(settings.__state.persisted.token).toBe('');
    });

    it('keeps the token when stayLoggedIn is on', async () => {
        settings.__state.cached.stayLoggedIn = true;

        await expect(clearTokenUnlessStayingLoggedIn()).resolves.toBe(false);
        expect(settings.__state.cached.token).toBe('old-token');
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    it('does nothing when there is no token to clear', async () => {
        settings.__state.cached.token = '';

        await expect(clearTokenUnlessStayingLoggedIn()).resolves.toBe(false);
        expect(settings.setSetting).not.toHaveBeenCalled();
    });
});
