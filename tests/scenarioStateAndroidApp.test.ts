/**
 * The scenario state on the Android app window (Capacitor, write-behind to Preferences): a spend's marker stays in the
 * cache when Preferences refuses it, a start-up read that failed reads as unreadable, and a reset is judged by its own
 * write — through the real stores, the real transport and a Preferences that can be made to fail.
 */

import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';

const failing = new Set<string>();
const stored = new Map<string, string | null>();
const mockPrefSet = jest.fn<Promise<void>, [SetOptions]>(async ({ key, value }) => {
    if (failing.has(key)) throw new Error('disk full');
    stored.set(key, value);
});
const mockPrefGet = jest.fn<Promise<GetResult>, [GetOptions]>(async ({ key }) => {
    if (failing.has(`read:${key}`)) throw new Error('bridge down');
    return { value: stored.get(key) ?? null };
});
jest.mock(
    '@capacitor/preferences',
    () => ({
        Preferences: {
            set: (...a: Parameters<typeof mockPrefSet>) => mockPrefSet(...a),
            get: (...a: Parameters<typeof mockPrefGet>) => mockPrefGet(...a),
        },
    }),
    { virtual: true },
);
jest.mock('../src/ts/joinStateStore', () => ({
    acquireUnlockLock: jest.fn((_id: string | number) => ({ ok: true, release: () => {} })),
}));
jest.mock('../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => category) };
});

import type * as scenarioStateStoreModule from '../src/ts/scenarioStateStore';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
};

const STATE = 'gs_scenario_state';
const RESETS = 'gs_scenario_resets';

let store: typeof scenarioStateStoreModule;
const { initialState } = require('../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;
const record = () => initialState('Plan', 'buildup', 1000);
const stopped = () => ({ ...record(), inFlight: { ruleId: 'r', actionIndex: 0, unclear: ['swap' as const] } });

const boot = async (files: Record<string, string> = {}) => {
    for (const [key, value] of Object.entries(files)) stored.set(key, value);
    jest.isolateModules(() => {
        store = require('../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;
    });
    await store.initializeScenarioStateAsync();
};

const file = (map: Record<string, unknown>) => JSON.stringify(map);

beforeEach(() => {
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
});
afterEach(() => {
    delete g.Capacitor;
    failing.clear();
    stored.clear();
    jest.clearAllMocks();
});

describe('a spend’s marker when Preferences refuses it', () => {
    test('stays in the cache, so the next pass finds it instead of spending again', async () => {
        await boot();
        failing.add(STATE);
        const marker = { ...record(), inFlight: { ruleId: 'r', actionIndex: 0, pending: 'swap' as const } };
        expect(store.scenarioStateLedger.set(7, marker)).toBe('saved');
        await expect(store.flushScenarioStateWrites()).rejects.toThrow('was not persisted');
        expect(store.scenarioStateLedger.get(7).state?.inFlight?.pending).toBe('swap');
    });
});

describe('a start-up read that failed', () => {
    test('reads as an unreadable file, never as an empty one, until the cache holds something known', async () => {
        failing.add(`read:${STATE}`);
        await boot({ [STATE]: file({ 7: stopped() }) });
        expect(store.scenarioStateLedger.get(7)).toMatchObject({ corrupt: 'file', state: null });
        expect(store.scenarioStateLedger.set(7, record())).toBe('failed');
        failing.delete(`read:${STATE}`);
        await store.refreshScenarioStateAsync();
        expect(store.scenarioStateLedger.get(7)).toMatchObject({ corrupt: false });
        expect(store.scenarioStateLedger.get(7).state?.inFlight?.unclear).toEqual(['swap']);
    });

    test('is cleared by the reset of every challenge, which is what the card then offers', async () => {
        failing.add(`read:${STATE}`);
        await boot();
        expect(store.scenarioStateLedger.get(7).corrupt).toBe('file');
        expect(store.scenarioStateLedger.removeAll()).toBe('removed');
        expect(store.scenarioStateLedger.get(7).corrupt).toBe(false);
    });
});

describe('a reset asked for on the app window', () => {
    const files = () => ({ [STATE]: file({ 7: stopped(), 8: stopped() }) });

    test('that was not saved is taken back: the next read does not apply it, and a later reset does not persist it', async () => {
        await boot(files());
        failing.add(RESETS);
        const judge = store.watchScenarioWrites();
        expect(store.scenarioStateLedger.remove(7)).toBe('removed');
        await expect(judge()).rejects.toThrow('was not persisted');
        expect(store.scenarioStateLedger.get(7).state).not.toBeNull();
        failing.delete(RESETS);
        const next = store.watchScenarioWrites();
        expect(store.scenarioStateLedger.remove(8)).toBe('removed');
        await expect(next()).resolves.toBeUndefined();
        expect(Object.keys(JSON.parse(stored.get(RESETS) ?? '{}') as object)).toEqual(['8']);
        expect(store.scenarioStateLedger.get(7).state).not.toBeNull();
        expect(store.scenarioStateLedger.get(8).state).toBeNull();
    });

    test('is saved though a write of the state failed before it and was never asked about', async () => {
        await boot(files());
        failing.add(STATE);
        store.scenarioStateLedger.set(9, record());
        failing.delete(STATE);
        const judge = store.watchScenarioWrites();
        store.scenarioStateLedger.remove(7);
        await expect(judge()).resolves.toBeUndefined();
    });

    test('is saved though a write queued after its own fails', async () => {
        await boot(files());
        const judge = store.watchScenarioWrites();
        store.scenarioStateLedger.remove(7);
        const told = judge();
        failing.add(STATE);
        store.scenarioStateLedger.set(9, record());
        await expect(told).resolves.toBeUndefined();
    });
});
