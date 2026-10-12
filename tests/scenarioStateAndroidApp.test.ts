/**
 * The scenario state on the Android app window (Capacitor, write-behind to Preferences): a spend's marker stays in the
 * cache when Preferences refuses it, a reset shows only once it is saved, and a start-up read that failed reads as not
 * loaded — through the real stores, the real transport and a Preferences that can be made to fail.
 */

import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';

const failing = new Set<string>();
const stored = new Map<string, string | null>();
const mockPrefSet = jest.fn<Promise<void>, [SetOptions]>(async ({ key, value }) => {
    if (failing.has(key)) throw new Error('disk full');
    stored.set(key, value);
});
const readOne = async ({ key }: GetOptions): Promise<GetResult> => {
    if (failing.has(`read:${key}`)) throw new Error('bridge down');
    return { value: stored.get(key) ?? null };
};
const mockPrefGet = jest.fn<Promise<GetResult>, [GetOptions]>(readOne);
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
    mockPrefGet.mockImplementation(readOne);
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

describe('a spend’s marker that Preferences refused, when the app window reads what is saved', () => {
    test('is still there after the refresh, so the next pass finds it instead of spending again', async () => {
        await boot();
        failing.add(STATE);
        const marker = { ...record(), inFlight: { ruleId: 'r', actionIndex: 0, pending: 'swap' as const } };
        expect(store.scenarioStateLedger.set(7, marker)).toBe('saved');
        await expect(store.flushScenarioStateWrites()).rejects.toThrow('was not persisted');
        failing.delete(STATE);
        await store.refreshScenarioStateAsync();
        expect(store.scenarioStateLedger.get(7).state?.inFlight?.pending).toBe('swap');
    });
});

describe('a reset asked for on the app window', () => {
    const files = () => ({ [STATE]: file({ 7: stopped(), 8: stopped() }) });
    const ledger = () => store.scenarioStateLedger;

    test('that was not saved changed nothing: no read applies it, and the next reset does not carry it', async () => {
        await boot(files());
        failing.add(RESETS);
        await expect(ledger().remove(7)).resolves.toBe('not-saved');
        expect(ledger().get(7).state).not.toBeNull();
        failing.delete(RESETS);
        await expect(ledger().remove(8)).resolves.toBe('removed');
        expect(Object.keys(JSON.parse(stored.get(RESETS) ?? '{}') as object)).toEqual(['8']);
        expect(ledger().get(7).state).not.toBeNull();
        expect(ledger().get(8).state).toBeNull();
    });

    test('that was not saved is not applied by a refresh that was in flight meanwhile', async () => {
        await boot(files());
        let answer!: (value: GetResult) => void;
        const refreshed = new Promise<void>((resolve) => {
            mockPrefGet.mockImplementationOnce(readOne);
            mockPrefGet.mockImplementationOnce(() => {
                resolve();
                return new Promise<GetResult>((resolveGet) => {
                    answer = resolveGet;
                });
            });
        });
        const refreshing = store.refreshScenarioStateAsync();
        await refreshed;
        failing.add(RESETS);
        await expect(ledger().remove(7)).resolves.toBe('not-saved');
        answer({ value: null });
        await refreshing;
        expect(ledger().get(7).state).not.toBeNull();
    });

    test('that was saved while a refresh that predates it was in flight is still applied after it', async () => {
        await boot(files());
        let answer!: (value: GetResult) => void;
        const reading = new Promise<void>((resolve) => {
            mockPrefGet.mockImplementationOnce(async ({ key }) => ({ value: stored.get(key) ?? null }));
            mockPrefGet.mockImplementationOnce(() => {
                resolve();
                return new Promise<GetResult>((resolveGet) => {
                    answer = resolveGet;
                });
            });
        });
        const refreshing = store.refreshScenarioStateAsync();
        await reading;
        await expect(ledger().remove(7)).resolves.toBe('removed');
        answer({ value: null });
        await refreshing;
        expect(ledger().get(7).state).toBeNull();
    });
});

describe('a reset of every challenge on progress that cannot be read', () => {
    test('that was not saved changed nothing: the file still cannot be read, and a retry that is saved clears it', async () => {
        await boot({ [STATE]: '{no' });
        expect(store.scenarioStateLedger.get(7).corrupt).toBe('file');
        failing.add(STATE);
        await expect(store.scenarioStateLedger.removeAll(true)).resolves.toBe('not-saved');
        expect(store.scenarioStateLedger.get(7).corrupt).toBe('file');
        failing.delete(STATE);
        await expect(store.scenarioStateLedger.removeAll(true)).resolves.toBe('removed');
        expect(store.scenarioStateLedger.get(7).corrupt).toBe(false);
    });

    test('is not made once the file turns out to read again: its progress is not wiped', async () => {
        failing.add(`read:${STATE}`);
        await boot({ [STATE]: file({ 7: stopped() }) });
        failing.delete(`read:${STATE}`);
        await store.refreshScenarioStateAsync();
        await expect(store.scenarioStateLedger.removeAll(true)).resolves.toBe('readable');
        expect(store.scenarioStateLedger.get(7).state?.inFlight?.unclear).toEqual(['swap']);
        expect(stored.get(RESETS)).toBeUndefined();
    });
});

describe('a start-up read that failed', () => {
    const ledger = () => store.scenarioStateLedger;

    test.each([STATE, RESETS])('of %s reads as not loaded: paused, nothing written, nothing reset', async (key) => {
        failing.add(`read:${key}`);
        await boot({ [STATE]: file({ 7: stopped() }) });
        expect(ledger().get(7)).toMatchObject({ corrupt: 'unloaded', state: null });
        expect(ledger().set(7, record())).toBe('failed');
        await expect(ledger().remove(7)).resolves.toBe('unloaded');
        await expect(ledger().removeAll()).resolves.toBe('unloaded');
        expect(store.scenarioStateLoaded()).toBe(false);
        expect(mockPrefSet).not.toHaveBeenCalled();
    });

    test.each([STATE, RESETS])(
        'of %s is retried by the next refresh, and the plans read again from what is saved',
        async (key) => {
            failing.add(`read:${key}`);
            await boot({ [STATE]: file({ 7: stopped() }) });
            failing.delete(`read:${key}`);
            await store.refreshScenarioStateAsync();
            expect(store.scenarioStateLoaded()).toBe(true);
            expect(ledger().get(7).state?.inFlight?.unclear).toEqual(['swap']);
        },
    );

    test('is nothing to a platform that reads its files itself', async () => {
        delete g.Capacitor;
        failing.add(`read:${STATE}`);
        await boot();
        expect(store.scenarioStateLoaded()).toBe(true);
    });
});

describe('the background service', () => {
    const h = globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean; AndroidHeadlessStore?: unknown };
    const saved = new Map<string, string>();
    const bridge = (readThrows: string[] = []) => {
        const writeKey = jest.fn((key: string, data: string) => {
            saved.set(key, data);
            return true;
        });
        h.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: (key: string) => {
                if (readThrows.includes(key)) throw new Error('bridge down');
                return saved.get(key) ?? null;
            },
            writeKey,
        };
        return writeKey;
    };
    const service = () => {
        delete g.Capacitor;
        h.__GS_HEADLESS__ = true;
        jest.isolateModules(() => {
            store = require('../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;
        });
    };
    afterEach(() => {
        delete h.__GS_HEADLESS__;
        delete h.AndroidHeadlessStore;
        saved.clear();
    });

    test.each([STATE, RESETS])(
        'a read of %s that threw is not progress that is empty: plans pause, nothing is written',
        (key) => {
            saved.set(STATE, file({ 7: stopped() }));
            const writeKey = bridge([key]);
            service();
            expect(store.scenarioStateLedger.get(7)).toMatchObject({ corrupt: 'unloaded', state: null });
            expect(store.scenarioStateLedger.set(7, record())).toBe('failed');
            expect(store.scenarioStateLoaded()).toBe(false);
            expect(writeKey).not.toHaveBeenCalled();
        },
    );

    test('a read that works again reads what is saved, and the progress is not lost to an empty one', async () => {
        saved.set(STATE, file({ 7: stopped() }));
        bridge([STATE]);
        service();
        expect(store.scenarioStateLedger.get(7).corrupt).toBe('unloaded');
        bridge();
        expect(store.scenarioStateLedger.get(7).state?.inFlight?.unclear).toEqual(['swap']);
        expect(store.scenarioStateLoaded()).toBe(true);
    });

    test('a key that is not there is progress that was never made, not a failed read', () => {
        bridge();
        service();
        expect(store.scenarioStateLedger.get(7)).toMatchObject({ corrupt: false, state: null });
        expect(store.scenarioStateLedger.set(7, record())).toBe('saved');
    });
});
