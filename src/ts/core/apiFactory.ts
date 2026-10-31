/**
 * GuruShots Auto Voter - API Factory
 *
 * Selects the real or mock API surface based on the current mock
 * setting and constructs the BaseMiddleware that wraps it. Each
 * surface is a plain object whose method names mirror what the
 * middleware expects — there is no class hierarchy. The real surface
 * is the api/ endpoint wrappers plus the real-strategy composition
 * (strategies/real); the mock surface is mockApiClient (mock/index.ts).
 */

import * as settings from './settings';
import { BaseMiddleware } from './services/BaseMiddleware';
import * as logger from './logger';

import type { EntryAgeLedger } from './types/stores';
import { entryAgeLedger } from './entryAgeStore';
import { authenticate } from './api/login';
import {
    fetchChallengesAndVote,
    applyBoostsOnSuspend,
    getActiveChallenges,
    applyBoost,
    runTurboGame,
    joinChallenge,
    forgetUnconfirmedPayment,
    submitToChallenge,
    swapPhoto,
    getSuggestedPhotoIds,
} from './strategies/real';
import { getVoteImages, submitVotes } from './api/voting';
import { applyBoostToEntry } from './api/boost';
import { applyTurbo } from './api/turbo';
import { getEligiblePhotos, getEligiblePhotosWalk, getImageData } from './api/submissions';
import { getMemberChallenges, getBankroll } from './api/join';
import { getCurrentMemberProfile, searchTagAutocomplete } from './api/tags';
import { keyUnlock, exposureAutofill } from './api/currency';
import { mockApiClient, mockEntryAgeLedger } from './mock';

const realApi = {
    authenticate,
    fetchChallengesAndVote,
    applyBoostsOnSuspend,
    runTurboGame,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    applyTurbo,
    getEligiblePhotos,
    getEligiblePhotosWalk,
    getImageData,
    submitToChallenge,
    getMemberChallenges,
    getBankroll,
    getCurrentMemberProfile,
    searchTagAutocomplete,
    joinChallenge,
    forgetUnconfirmedPayment,
    keyUnlock,
    swapPhoto,
    exposureAutofill,
    getSuggestedPhotoIds,
    getStrategyType: () => 'RealAPI',
};

/**
 * The API surface both strategies implement: the real one's shape. The mock
 * surface below is checked against it, so a method missing on either side or
 * a signature that drifts fails `pnpm typecheck`.
 */
export type ApiStrategy = typeof realApi;

/**
 * Wraps a mock implementation so each call emits a debug log first.
 */
const withMockDebug =
    <A extends unknown[], R>(label: string, fn: (...args: A) => R | Promise<R>): ((...args: A) => Promise<R>) =>
    async (...args) => {
        logger.withCategory('api').debug(`🔧 Using mock ${label}`, null);
        return fn(...args);
    };

/** The client with every own function property behind the debug preamble. */
type DebugWrapped<T> = { [K in keyof T]: T[K] };

/**
 * Wraps every own property of `obj` in withMockDebug, keyed by the property
 * name (`labels` renames one). Runs once at module load, so the wrapped
 * methods are the client's as they are now.
 */
const wrapWithDebug = <T extends Record<string, (...args: never[]) => unknown>>(
    obj: T,
    labels: Partial<Record<keyof T, string>>,
): DebugWrapped<T> => {
    const wrapped = {} as DebugWrapped<T>;
    for (const name of Object.keys(obj) as Array<keyof T & string>) {
        wrapped[name] = withMockDebug(labels[name] ?? name, obj[name]) as DebugWrapped<T>[typeof name];
    }
    return wrapped;
};

/**
 * Each method is the matching mockApiClient method behind the debug
 * preamble. (The `authenticate` log label is 'authentication' so log lines
 * keep a stable wording.)
 */
const mockApi: ApiStrategy = {
    ...wrapWithDebug(mockApiClient, { authenticate: 'authentication' }),
    getStrategyType: () => 'MockAPI',
};

let currentStrategy: ApiStrategy | null = null;
let currentMiddleware: InstanceType<typeof BaseMiddleware> | null = null;
let lastMockSetting: boolean | null = null;

/**
 * Returns the active API surface.
 *
 * Without arguments the surface follows the persisted `mock` setting
 * (cached until refreshApi or the setting changes). Passing an explicit
 * boolean `mock` overrides the setting for THIS call only — used by the
 * login flow, where the caller's choice pre-dates the committed setting —
 * without touching the cached strategy state.
 */
const getApiStrategy = ({ mock }: { mock?: boolean } = {}): ApiStrategy => {
    if (typeof mock === 'boolean') {
        return mock ? mockApi : realApi;
    }
    const userSettings = settings.loadSettings();
    if (lastMockSetting !== userSettings.app.mock || !currentStrategy) {
        logger.withCategory('api').debug('=== API Factory Debug ===', null);
        logger.withCategory('settings').debug(`Mock setting: ${userSettings.app.mock}`);
        logger.withCategory('settings').debug(`Token exists: ${!!userSettings.auth.token}`);

        if (userSettings.app.mock) {
            logger.withCategory('api').info('✅ Using MOCK API strategy for development/testing', null);
            currentStrategy = mockApi;
        } else {
            logger.withCategory('api').info('🌐 Using REAL API strategy for production', null);
            currentStrategy = realApi;
        }

        lastMockSetting = userSettings.app.mock;
        currentMiddleware = null;
    }
    return currentStrategy;
};

const getMiddleware = () => {
    const strategy = getApiStrategy();
    if (!currentMiddleware) {
        logger.withCategory('api').debug(`Creating middleware with ${strategy.getStrategyType()} strategy`, null);
        currentMiddleware = new BaseMiddleware(strategy);
    }
    return currentMiddleware;
};

const refreshApi = () => {
    logger.withCategory('settings').info('🔄 Forcing API refresh due to settings change');
    currentStrategy = null;
    currentMiddleware = null;
    lastMockSetting = null;
};

/**
 * The entry-age ledger for node-side READ views of what the voting pass writes
 * (the deadline view's Boost-pinned-submit latch). The view must read the same
 * ledger the runner writes: mock mode uses the mock surface's in-memory ledger
 * and never touches the persisted entry-age file, so a latch the mock runner
 * set would be invisible to a view that read the persisted one. Mirrors how
 * getApiStrategy selects on the persisted `mock` setting.
 */
const getEntryAgeLedger = (): EntryAgeLedger =>
    settings.loadSettings().app.mock ? mockEntryAgeLedger : entryAgeLedger;

// The raw surfaces are deliberately NOT exported — every caller selects a
// surface through getApiStrategy (optionally with the explicit { mock }
// override) so the factory stays the single swap point.
export { getApiStrategy, getMiddleware, refreshApi, getEntryAgeLedger };
