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
