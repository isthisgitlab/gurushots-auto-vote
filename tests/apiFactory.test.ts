/**
 * Tests for apiFactory.ts
 *
 * Covers strategy selection (mock vs real), middleware caching, and refresh.
 */

jest.mock('../src/ts/settings', () => ({
    loadSettings: jest.fn(),
}));

jest.mock('../src/ts/services/BaseMiddleware', () => ({
    BaseMiddleware: jest.fn().mockImplementation((strategy: unknown) => ({
        strategy,
        mockMiddlewareInstance: true,
    })),
}));

jest.mock('../src/ts/api/login', () => ({ authenticate: jest.fn() }));
jest.mock('../src/ts/strategies/real', () => ({
    fetchChallengesAndVote: jest.fn(),
    applyBoostsOnSuspend: jest.fn(),
    getActiveChallenges: jest.fn(),
    applyBoost: jest.fn(),
    joinChallenge: jest.fn(),
}));
jest.mock('../src/ts/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../src/ts/api/boost', () => ({ applyBoostToEntry: jest.fn() }));
jest.mock('../src/ts/api/turbo', () => ({ applyTurbo: jest.fn() }));
jest.mock('../src/ts/api/submissions', () => ({
    getEligiblePhotos: jest.fn(),
    getImageData: jest.fn(),
    submitToChallenge: jest.fn(),
}));
jest.mock('../src/ts/api/currency', () => ({
    keyUnlock: jest.fn(),
    swapPhoto: jest.fn(),
    exposureAutofill: jest.fn(),
}));
jest.mock('../src/ts/mock', () => ({
    mockApiClient: {
        authenticate: jest.fn(),
        fetchChallengesAndVote: jest.fn(),
        applyBoostsOnSuspend: jest.fn(),
        runTurboMiniGame: jest.fn(),
        getActiveChallenges: jest.fn(),
        getVoteImages: jest.fn(),
        submitVotes: jest.fn(),
        applyBoost: jest.fn(),
        applyBoostToEntry: jest.fn(),
        applyTurbo: jest.fn(),
        getEligiblePhotos: jest.fn(),
        getImageData: jest.fn(),
        submitToChallenge: jest.fn(),
        getMemberChallenges: jest.fn(),
        getBankroll: jest.fn(),
        getCurrentMemberProfile: jest.fn(),
        searchTagAutocomplete: jest.fn(),
        joinChallenge: jest.fn(),
        keyUnlock: jest.fn(),
        swapPhoto: jest.fn(),
        exposureAutofill: jest.fn(),
    },
}));

jest.mock('../src/ts/logger', () => {
    const mock = {
        info: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        debug: jest.fn(),
        cliInfo: jest.fn(),
        cliSuccess: jest.fn(),
        cliError: jest.fn(),
        api: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        apiRequest: jest.fn(),
        apiResponse: jest.fn(),
        isDevMode: jest.fn(() => false),
        withCategory: jest.fn(
            (): Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'> => ({
                info: mock.info,
                error: mock.error,
                debug: mock.debug,
                success: mock.success,
                warning: mock.warning,
            }),
        ),
    };
    return mock;
});

const { getApiStrategy, getMiddleware, refreshApi } = require('../src/ts/apiFactory') as typeof apiFactoryModule;
// The raw surfaces are not exported — the explicit override returns the
// module-level singletons, so identity assertions still hold.
const realApi = getApiStrategy({ mock: false });
const mockApi = getApiStrategy({ mock: true });
import settingsModule = require('../src/ts/settings');
const settings = jest.mocked(settingsModule);
const { BaseMiddleware } = jest.mocked(require('../src/ts/services/BaseMiddleware') as typeof BaseMiddlewareModule);
import mockLoggerModule = require('../src/ts/logger');
const mockLogger = jest.mocked(mockLoggerModule);
import type * as apiFactoryModule from '../src/ts/apiFactory';
import type { CategoryLogger } from '../src/ts/logger';
import type * as BaseMiddlewareModule from '../src/ts/services/BaseMiddleware';
import type * as mockModule from '../src/ts/mock';
import { invalid } from './helpers/invalid';

describe('apiFactory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        refreshApi();
    });

    describe('getApiStrategy', () => {
        test('returns the mock surface when mock setting is true', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: true, token: 'tok' }));
            expect(getApiStrategy()).toBe(mockApi);
            expect(mockLogger.info).toHaveBeenCalledWith('✅ Using MOCK API strategy for development/testing', null);
        });

        test('returns the real surface when mock setting is false', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: false, token: 'tok' }));
            expect(getApiStrategy()).toBe(realApi);
            expect(mockLogger.info).toHaveBeenCalledWith('🌐 Using REAL API strategy for production', null);
        });

        test('logs debug context on (re)selection', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: true, token: 'tok' }));
            getApiStrategy();
            expect(mockLogger.debug).toHaveBeenCalledWith('=== API Factory Debug ===', null);
            expect(mockLogger.debug).toHaveBeenCalledWith('Mock setting: true');
            expect(mockLogger.debug).toHaveBeenCalledWith('Token exists: true');
        });

        test('reports missing token as not present', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: false, token: null }));
            getApiStrategy();
            expect(mockLogger.debug).toHaveBeenCalledWith('Token exists: false');
        });

        test('caches the strategy across calls when the setting does not change', () => {
            settings.loadSettings.mockReturnValue(invalid({ mock: true, token: 'tok' }));
            const a = getApiStrategy();
            const b = getApiStrategy();
            expect(a).toBe(b);
            expect(settings.loadSettings).toHaveBeenCalledTimes(2);
        });

        test('switches surface when the mock setting flips', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: true, token: 'tok' }));
            const first = getApiStrategy();
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: false, token: 'tok' }));
            const second = getApiStrategy();
            expect(first).toBe(mockApi);
            expect(second).toBe(realApi);
        });

        test('exposes a getStrategyType label on each surface', () => {
            expect(realApi.getStrategyType()).toBe('RealAPI');
            expect(mockApi.getStrategyType()).toBe('MockAPI');
        });
    });

    describe('getMiddleware', () => {
        test('wraps the mock surface in a fresh middleware', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: true, token: 'tok' }));
            const mw = getMiddleware();
            expect(BaseMiddleware).toHaveBeenCalledWith(mockApi);
            expect(invalid<{ mockMiddlewareInstance: boolean }>(mw).mockMiddlewareInstance).toBe(true);
            expect(mockLogger.debug).toHaveBeenCalledWith('Creating middleware with MockAPI strategy', null);
        });

        test('wraps the real surface in a fresh middleware', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: false, token: 'tok' }));
            const mw = getMiddleware();
            expect(BaseMiddleware).toHaveBeenCalledWith(realApi);
            expect(invalid<{ mockMiddlewareInstance: boolean }>(mw).mockMiddlewareInstance).toBe(true);
            expect(mockLogger.debug).toHaveBeenCalledWith('Creating middleware with RealAPI strategy', null);
        });

        test('returns the cached middleware on subsequent calls', () => {
            settings.loadSettings.mockReturnValue(invalid({ mock: true, token: 'tok' }));
            const a = getMiddleware();
            const b = getMiddleware();
            expect(a).toBe(b);
            expect(BaseMiddleware).toHaveBeenCalledTimes(1);
        });

        test('rebuilds when the underlying strategy changes', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: true, token: 'tok' }));
            const first = getMiddleware();
            refreshApi();
            settings.loadSettings.mockReturnValueOnce(invalid({ mock: false, token: 'tok' }));
            const second = getMiddleware();
            expect(first).not.toBe(second);
            expect(BaseMiddleware).toHaveBeenCalledTimes(2);
        });
    });

    describe('refreshApi', () => {
        test('clears strategy and middleware caches', () => {
            settings.loadSettings.mockReturnValue(invalid({ mock: true, token: 'tok' }));
            const s1 = getApiStrategy();
            const m1 = getMiddleware();
            refreshApi();
            const s2 = getApiStrategy();
            const m2 = getMiddleware();
            expect(s1).toBe(s2); // singleton object identity preserved
            expect(m1).not.toBe(m2); // but the middleware was rebuilt
            expect(BaseMiddleware).toHaveBeenCalledTimes(2);
        });

        test('logs the refresh', () => {
            refreshApi();
            expect(mockLogger.info).toHaveBeenCalledWith('🔄 Forcing API refresh due to settings change');
        });
    });

    describe('integration scenarios', () => {
        test('treats an empty settings object as real mode', () => {
            settings.loadSettings.mockReturnValueOnce(invalid({}));
            expect(getApiStrategy()).toBe(realApi);
            expect(mockLogger.debug).toHaveBeenCalledWith('Mock setting: undefined');
            expect(mockLogger.info).toHaveBeenCalledWith('🌐 Using REAL API strategy for production', null);
        });
    });

    describe('explicit { mock } override', () => {
        test('returns the requested surface without reading settings', () => {
            expect(getApiStrategy({ mock: true })).toBe(mockApi);
            expect(getApiStrategy({ mock: false })).toBe(realApi);
            expect(settings.loadSettings).not.toHaveBeenCalled();
        });

        test('does not disturb the cached settings-driven selection', () => {
            settings.loadSettings.mockReturnValue(invalid({ mock: false, token: 'tok' }));
            expect(getApiStrategy()).toBe(realApi);
            expect(getApiStrategy({ mock: true })).toBe(mockApi);
            // The settings-driven path still returns the cached real surface.
            expect(getApiStrategy()).toBe(realApi);
        });
    });

    describe('real/mock surface parity', () => {
        test('mockApi exposes exactly the realApi key set', () => {
            // Typecheck holds mockApi to realApi's type; this pins the runtime
            // surface too.
            expect(Object.keys(mockApi).sort()).toEqual(Object.keys(realApi).sort());
        });
    });

    describe('mock surface debug wrapper', () => {
        test('logs the mock label and forwards args/result to the wrapped client', async () => {
            const { mockApiClient } = jest.mocked(require('../src/ts/mock') as typeof mockModule);
            mockApiClient.authenticate.mockResolvedValueOnce(invalid('token-xyz'));
            const result = await mockApi.authenticate('user@example.com', 'pw');
            expect(result).toBe('token-xyz');
            expect(mockApiClient.authenticate).toHaveBeenCalledWith('user@example.com', 'pw');
            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock authentication', null);
        });
    });
});
