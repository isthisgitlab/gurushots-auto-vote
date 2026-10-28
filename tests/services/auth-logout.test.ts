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
import type { Challenge, DiscoverChallenge } from '../../src/ts/types/gurushots';
import type * as discoverChallengesModule from '../../src/ts/services/discoverChallenges';
import type * as libraryCacheModule from '../../src/ts/services/libraryCache';

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
            return true;
        }),
        forgetOpenChallengeIds: jest.fn(),
        // The mocked environment boots in mock mode: a logout must land back on this default.
        getEnvironmentInfo: jest.fn(() => ({ defaultMock: true })),
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
import type * as chosenPhotosModule from '../../src/ts/services/autoFill/chosenPhotos';
const { clearAuthToken, logout, switchAccountToken } = require('../../src/ts/services/auth') as typeof authModule;

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
        const open = invalid<DiscoverChallenge>({ id: 9, title: 'Rule Match' });
        rememberOpenChallenges([open, null]);
        expect(getOpenChallenge('9')).toBe(open);
        expect(getOpenChallenge(9)).toBeDefined();
        await clearAuthToken();
        expect(getOpenChallenge(9)).toBeUndefined();
    });

    it('forgets the open- and upcoming-id lists cleanup spares chosen lists for', async () => {
        await clearAuthToken();
        // One call forgets both: they live side by side in settings/openChallenges.
        expect(settings.forgetOpenChallengeIds).toHaveBeenCalledTimes(1);
    });

    it('forgets the photo-library listings, so the next account is never shown the previous one’s', async () => {
        const { writeListing, readFresh, readLatest } =
            require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;
        const listing = {
            photos: [],
            memberId: 'm',
            wonIds: [],
            wonCount: 0,
            truncated: false,
            nextStart: 0,
            allowedKnown: false,
            readAtMs: Date.now(),
        };
        writeListing(null, listing);
        expect(readFresh(null)).not.toBeNull();
        await clearAuthToken();
        expect(readFresh(null)).toBeNull();
        expect(readLatest()).toBeNull();
        switchAccountToken('another-token');
        // A login that replaces a different token forgets it too.
        writeListing(null, listing);
        switchAccountToken('a-third-token');
        expect(readFresh(null)).toBeNull();
    });

    it("forgets the cached upcoming list, so the next account is never shown the previous one's", async () => {
        const { fetchUpcoming } =
            require('../../src/ts/services/discoverChallenges') as typeof discoverChallengesModule;
        const fetchList = jest.fn(async () => [invalid<Challenge>({ id: 1 })]);
        await fetchUpcoming('old-token', fetchList);
        await fetchUpcoming('old-token', fetchList);
        expect(fetchList).toHaveBeenCalledTimes(1);
        await clearAuthToken();
        await fetchUpcoming('old-token', fetchList);
        expect(fetchList).toHaveBeenCalledTimes(2);
    });

    it('forgets the explained chosen-photo skips, so the next account is told its own', async () => {
        const { logChosenSkipOnce } =
            require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
        const warning = jest.fn();
        const fillLogger = invalid<Parameters<typeof logChosenSkipOnce>[0]>({
            withCategory: () => ({ warning }),
            challengeTag: () => '[Challenge 9]',
        });
        const challenge = invalid<Challenge>({ id: 9 });
        logChosenSkipOnce(fillLogger, challenge, 'autoSubmit', 'none-usable');
        logChosenSkipOnce(fillLogger, challenge, 'autoSubmit', 'none-usable');
        expect(warning).toHaveBeenCalledTimes(1);

        await clearAuthToken();
        logChosenSkipOnce(fillLogger, challenge, 'autoSubmit', 'none-usable');
        expect(warning).toHaveBeenCalledTimes(2);
    });

    it('durably persists the cleared token before resolving (Capacitor kill-safety)', async () => {
        const hadToken = await clearAuthToken();

        expect(hadToken).toBe(true);
        // Not just the cache — the simulated backing store must be clean.
        expect(settings.__state.persisted.token).toBe('');
        expect(settings.flushPendingWrites).toHaveBeenCalledTimes(1);
    });

    it('does not touch the mock flag — the mode reset belongs to the explicit logout', async () => {
        settings.__state.cached.mock = false;

        await clearAuthToken();

        // The quit path clears the token only: no reset write, and the environment was never asked for its default.
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(settings.getEnvironmentInfo).not.toHaveBeenCalled();
        expect(settings.__state.cached.mock).toBe(false);
    });

    it('reports a logout the settings refused, never takes it for one, and keeps what is remembered of the account that is still logged in', async () => {
        settings.setSetting.mockReturnValueOnce(false);

        await expect(clearAuthToken()).rejects.toThrow('logout-not-saved');

        expect(settings.forgetOpenChallengeIds).not.toHaveBeenCalled();
        expect(settings.flushPendingWrites).toHaveBeenCalledTimes(1);
    });

    it('reports false when no token was set', async () => {
        settings.__state.cached = { token: '' };
        expect(await clearAuthToken()).toBe(false);
    });
});

/**
 * The explicit-logout wrapper: everything clearAuthToken does, plus the mode's
 * return to the environment default. A quit with stay-logged-in off must never
 * reset the mode — only an explicit logout does — so the reset lives behind
 * this wrapper, not in the shared core.
 */
describe('logout', () => {
    beforeEach(() => {
        settings.__state.cached = { token: 'old-token' };
        settings.__state.persisted = { token: 'old-token' };
        settings.__state.flushCalls = 0;
        jest.clearAllMocks();
    });

    it('returns the mode to the environment default when the sign-out holds', async () => {
        settings.__state.cached.mock = false;

        await logout();

        expect(settings.setSetting).toHaveBeenCalledWith('mock', true);
        expect(settings.__state.cached.mock).toBe(true);
        expect(settings.__state.persisted.mock).toBe(true);
    });

    it('leaves the mock flag as it is when the settings refuse the sign-out', async () => {
        settings.__state.cached.mock = false;
        settings.setSetting.mockReturnValueOnce(false);

        await expect(logout()).rejects.toThrow('logout-not-saved');

        // Only the refused token write was attempted — no reset rode along.
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(settings.__state.cached.mock).toBe(false);
    });

    it('queues the mock reset before the flush, so the one durable write covers both', async () => {
        const order: string[] = [];
        let mockPendingAtFlush: unknown;
        settings.setSetting.mockImplementation(
            invalid<typeof settingsModule.setSetting>((key: string, value: unknown) => {
                order.push(key);
                settings.__state.cached[key] = value;
                return true;
            }),
        );
        settings.flushPendingWrites.mockImplementation(async () => {
            mockPendingAtFlush = settings.__state.cached.mock;
            order.push('flush');
            settings.__state.persisted = { ...settings.__state.cached };
        });

        await logout();

        // A Capacitor OS kill between the writes still loses the session: the reset
        // must already be queued when the flush — the only durability point — runs.
        expect(order).toEqual(['token', 'mock', 'flush']);
        expect(mockPendingAtFlush).toBe(true);
    });
});

/**
 * stayLoggedIn off must drop the token on every shell, CLI and Android included — otherwise
 * the token stays on disk indefinitely, the opposite of what the setting promises. The one
 * exception is armed Android: the launch clear (wired in tests/react/CapacitorEntry.test.tsx;
 * the web shell's are in tests/web/server.test.ts, the CLI's in the voting-command tests)
 * skips while background auto-vote is armed, because the armed service is the token's
 * designed consumer. The rule lives with the rest of the auth core so every shell can apply
 * it; the Electron single-instance gate stays in windows/lifecycle.ts because that part
 * really is Electron-specific.
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

describe('switchAccountToken — a login on top of another session', () => {
    beforeEach(() => {
        settings.__state.cached = { token: 'old-token' };
        settings.__state.persisted = { token: 'old-token' };
        jest.clearAllMocks();
        settings.setSetting.mockImplementation((key: string, value: unknown) => {
            settings.__state.cached[key] = value;
            return true;
        });
    });

    const remembered = () => {
        const { rememberOpenChallenges, getOpenChallenge } =
            require('../../src/ts/services/openChallengeCache') as typeof openChallengeCacheModule;
        const { logChosenSkipOnce } =
            require('../../src/ts/services/autoFill/chosenPhotos') as typeof chosenPhotosModule;
        const warning = jest.fn();
        const fillLogger = invalid<Parameters<typeof logChosenSkipOnce>[0]>({
            withCategory: () => ({ warning }),
            challengeTag: () => '[Challenge 9]',
        });
        const challenge = invalid<Challenge>({ id: 9 });
        rememberOpenChallenges([invalid<DiscoverChallenge>(challenge)]);
        logChosenSkipOnce(fillLogger, challenge, 'autoSubmit', 'none-usable');
        return {
            open: () => getOpenChallenge(9),
            skipExplained: () => {
                const before = warning.mock.calls.length;
                logChosenSkipOnce(fillLogger, challenge, 'autoSubmit', 'none-usable');
                return warning.mock.calls.length === before;
            },
        };
    };

    it("stores the new token and forgets the previous account's open challenges, open ids and skip state", () => {
        const memory = remembered();
        expect(memory.open()).toBeDefined();
        switchAccountToken('new-token');
        expect(settings.setSetting).toHaveBeenCalledWith('token', 'new-token');
        expect(settings.forgetOpenChallengeIds).toHaveBeenCalledTimes(1);
        expect(memory.open()).toBeUndefined();
        // The skip was forgotten, so the next account is told its own: logging again is not a repeat.
        expect(memory.skipExplained()).toBe(false);
    });

    it("forgets the previous account's cached upcoming list on a switch, and keeps it on the same token", async () => {
        const { fetchUpcoming } =
            require('../../src/ts/services/discoverChallenges') as typeof discoverChallengesModule;
        const fetchList = jest.fn(async () => [invalid<Challenge>({ id: 1 })]);
        await fetchUpcoming('tok-a', fetchList);
        switchAccountToken('old-token');
        await fetchUpcoming('tok-a', fetchList);
        expect(fetchList).toHaveBeenCalledTimes(1);
        switchAccountToken('new-token');
        await fetchUpcoming('tok-a', fetchList);
        expect(fetchList).toHaveBeenCalledTimes(2);
    });

    it('answers true when the token was saved', () => {
        expect(switchAccountToken('new-token')).toBe(true);
    });

    it('answers false, stores nothing and forgets nothing when the settings refuse the write', () => {
        const memory = remembered();
        settings.setSetting.mockReturnValueOnce(false);
        expect(switchAccountToken('new-token')).toBe(false);
        expect(settings.forgetOpenChallengeIds).not.toHaveBeenCalled();
        expect(memory.open()).toBeDefined();
        expect(settings.__state.cached.token).toBe('old-token');
    });

    it('keeps everything when the token is the one already stored', () => {
        const memory = remembered();
        switchAccountToken('old-token');
        expect(settings.forgetOpenChallengeIds).not.toHaveBeenCalled();
        expect(memory.open()).toBeDefined();
        expect(memory.skipExplained()).toBe(true);
    });
});
