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
import type * as accountScopeModule from '../../src/ts/services/accountScope';
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
const { clearAuthToken, switchAccountToken } = require('../../src/ts/services/auth') as typeof authModule;

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

    it('moves the account generation once, so a request begun before the logout writes nothing', async () => {
        const { accountGeneration } = require('../../src/ts/services/accountScope') as typeof accountScopeModule;
        const before = accountGeneration();
        await clearAuthToken();
        expect(accountGeneration()).toBe(before + 1);
        const afterLogout = accountGeneration();
        switchAccountToken('another-token');
        expect(accountGeneration()).toBe(afterLogout + 1);
        // The same token again is the same account.
        const same = accountGeneration();
        switchAccountToken('another-token');
        expect(accountGeneration()).toBe(same);
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
            allowedKnown: false,
            readAtMs: Date.now(),
        };
        writeListing('old-token', null, listing);
        expect(readFresh('old-token', null)).not.toBeNull();
        await clearAuthToken();
        expect(readFresh('old-token', null)).toBeNull();
        expect(readLatest('old-token')).toBeNull();
        switchAccountToken('old-token');
        writeListing('old-token', null, listing);
        switchAccountToken('old-token');
        // The same token again is the same account: its listings stay.
        expect(readFresh('old-token', null)).not.toBeNull();
        switchAccountToken('a-third-token');
        expect(readFresh('old-token', null)).toBeNull();
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

    it('flushes after the clear write, never before', async () => {
        const order: string[] = [];
        settings.setSetting.mockImplementation(
            invalid<typeof settingsModule.setSetting>((key: string, value: unknown) => {
                order.push('set');
                settings.__state.cached[key] = value;
                return true;
            }),
        );
        settings.flushPendingWrites.mockImplementation(async () => {
            order.push('flush');
            settings.__state.persisted = { ...settings.__state.cached };
        });

        await clearAuthToken();

        expect(order).toEqual(['set', 'flush']);
    });

    it('reports a logout the settings refused, never takes it for one, and keeps what is remembered of the account that is still logged in', async () => {
        settings.setSetting.mockReturnValueOnce(false);
        const { accountGeneration } = require('../../src/ts/services/accountScope') as typeof accountScopeModule;
        const before = accountGeneration();

        await expect(clearAuthToken()).rejects.toThrow('logout-not-saved');

        expect(accountGeneration()).toBe(before);
        expect(settings.forgetOpenChallengeIds).not.toHaveBeenCalled();
        expect(settings.flushPendingWrites).toHaveBeenCalledTimes(1);
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
