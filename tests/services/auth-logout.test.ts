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

import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

// The simulated write-behind store the settings mock exposes as __state.
type SettingsState = { cached: Record<string, unknown>; persisted: Record<string, unknown>; flushCalls: number };

jest.mock('../../src/ts/settings', () => {
    const state: SettingsState = {
        cached: { token: 'old-token' },
        persisted: { token: 'old-token' },
        flushCalls: 0,
    };
    return {
        __state: state,
        getSetting: jest.fn((key: string) => state.cached[key]),
        setSetting: jest.fn((key: string, value: unknown) => {
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

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule as typeof settingsModule & { __state: SettingsState });
import type * as authModule from '../../src/ts/services/auth';
import type * as openChallengeCacheModule from '../../src/ts/services/openChallengeCache';
const { clearAuthToken } = require('../../src/ts/services/auth') as typeof authModule;

describe('clearAuthToken', () => {
    beforeEach(() => {
        settings.__state.cached = { token: 'old-token' };
        settings.__state.persisted = { token: 'old-token' };
        settings.__state.flushCalls = 0;
        jest.clearAllMocks();
    });

    it('forgets the remembered open challenges, which belong to the account that left', async () => {
        const { rememberOpenChallenges, getOpenChallenge } =
            require('../../src/ts/services/openChallengeCache') as typeof openChallengeCacheModule;
        const open = invalid<Challenge>({ id: 9, title: 'Rule Match' });
        rememberOpenChallenges([open, null]);
        expect(getOpenChallenge('9')).toBe(open);
        expect(getOpenChallenge(9)).toBeDefined();
        await clearAuthToken();
        expect(getOpenChallenge(9)).toBeUndefined();
    });

    it('durably persists the cleared token before resolving (Capacitor kill-safety)', async () => {
        const hadToken = await clearAuthToken();

        expect(hadToken).toBe(true);
        // Not just the cache — the simulated backing store must be clean.
        expect(settings.__state.persisted.token).toBe('');
        expect(settings.flushPendingWrites).toHaveBeenCalledTimes(1);
    });

    it('flushes after the clear write, never before', async () => {
        const order: string[] = [];
        settings.setSetting.mockImplementation(
            invalid<typeof settingsModule.setSetting>((key: string, value: unknown) => {
                order.push('set');
                settings.__state.cached[key] = value;
            }),
        );
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
});

/**
 * stayLoggedIn off must drop the token on every shell, CLI and Android included — otherwise
 * the token stays on disk indefinitely, the opposite of what the setting promises. The rule
 * lives with the rest of the auth core so every shell can apply it; the Electron
 * single-instance gate stays in windows/lifecycle.ts because that part really is
 * Electron-specific.
 */
describe('clearTokenUnlessStayingLoggedIn', () => {
    const { clearTokenUnlessStayingLoggedIn } = require('../../src/ts/services/auth') as typeof authModule;

    beforeEach(() => {
        settings.__state.cached = { token: 'old-token', stayLoggedIn: false };
        settings.__state.persisted = { token: 'old-token' };
        settings.flushPendingWrites = invalid(
            jest.fn(async () => {
                settings.__state.persisted = { ...settings.__state.cached };
            }),
        );
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
