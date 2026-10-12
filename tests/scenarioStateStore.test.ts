/**
 * Scenario runtime state ledger: per-challenge records, corruption reported
 * (never read as a fresh start), pruning, and the parse memo.
 */

jest.mock('../src/ts/joinStateStore', () => ({
    acquireUnlockLock: jest.fn((_id: string | number, _category?: string) => ({ ok: true, release: () => {} })),
}));

const {
    scenarioStepLock,
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    scenarioStateLedger,
    mockScenarioStateLedger,
    initializeScenarioStateAsync,
    flushScenarioStateWrites,
} = require('../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;
import fsModule = require('node:fs');
import joinStateStoreModule = require('../src/ts/joinStateStore');
const acquireUnlockLock = jest.mocked(joinStateStoreModule.acquireUnlockLock);
import loggerModule = require('../src/ts/logger');
const logger = jest.mocked(loggerModule);
import type * as scenarioStateStoreModule from '../src/ts/scenarioStateStore';
import type { CategoryLogger } from '../src/ts/logger';
import { invalid } from './helpers/invalid';

jest.mock('../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => category) };
});

const rawStore = (initial: string | null = null) => {
    const store: { raw: string | null; readRaw: () => string | null; writeRaw: (data: string) => void } = {
        raw: initial,
        readRaw: jest.fn(() => store.raw),
        writeRaw: jest.fn((data: string) => {
            store.raw = data;
        }),
    };
    return store;
};

const state = () => initialState('Plan', 'buildup', 1000);

describe('initialState', () => {
    test('starts at the given phase with nothing remembered, fired or spent', () => {
        expect(state()).toEqual({
            scenario: 'Plan',
            phase: 'buildup',
            phaseEnteredAt: 1000,
            memory: {},
            fired: {},
            inFlight: null,
            spent: { swaps: 0, keys: 0, fills: 0 },
            history: {},
            outbox: [],
            lastAction: null,
            lastError: null,
        });
    });
});

describe('createStateLedger', () => {
    test('no record yet reads as no state', () => {
        const ledger = createStateLedger(rawStore());
        expect(ledger.get(7)).toEqual({ corrupt: false, state: null });
    });

    test('a record from before vote history existed is still readable', () => {
        const legacy = { ...state(), updatedAt: Date.now() };
        delete legacy.history;
        expect(createStateLedger(rawStore(JSON.stringify({ 7: legacy }))).get(7).corrupt).toBe(false);
    });

    test('round-trips a record per challenge, ids as strings, copies returned', () => {
        const ledger = createMemoryStateLedger();
        ledger.set(7, { ...state(), memory: { held: 'p1' }, inFlight: { ruleId: 'r1', actionIndex: 1 } });
        const { state: read } = ledger.get('7');
        expect(read!.memory).toEqual({ held: 'p1' });
        expect(read!.updatedAt).toEqual(expect.any(Number));
        read!.memory.held = 'changed';
        expect(ledger.get(7).state!.memory.held).toBe('p1');
        expect(ledger.get(8).state).toBeNull();
    });

    test('the step of a spend that got no answer, marked on the rule in flight, is kept', () => {
        const ledger = createMemoryStateLedger();
        ledger.set(7, { ...state(), inFlight: { ruleId: 'r1', actionIndex: 1, unclear: 'swap' } });
        expect(ledger.get(7).state!.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1, unclear: 'swap' });
        const raw = rawStore(
            JSON.stringify({ 7: { ...state(), inFlight: { ruleId: 'r1', actionIndex: 1, unclear: 'swap' } } }),
        );
        expect(createStateLedger(raw).get(7).state!.inFlight?.unclear).toBe('swap');
    });

    test('an unreadable file is corrupt for every challenge, and logged once', () => {
        const ledger = createStateLedger(rawStore('{not json'));
        expect(ledger.get(7)).toEqual({ corrupt: true, state: null });
        expect(ledger.get(8)).toEqual({ corrupt: true, state: null });
        expect(invalid<() => CategoryLogger>(logger.withCategory)().error).toHaveBeenCalledTimes(1);
    });

    test('a file with nothing in it was cut short: it is corrupt, never "no state" that the next write replaces', () => {
        const store = rawStore('');
        const ledger = createStateLedger(store);
        expect(ledger.get(7)).toEqual({ corrupt: true, state: null });
        expect(createStateLedger(rawStore('  \n')).get(7).corrupt).toBe(true);
        expect(store.writeRaw).not.toHaveBeenCalled();
    });

    test.each(['swap', 'unlockBoost', 'fillExposure'])('a rule stopped after %s is read as stopped', (action) => {
        const record = { ...state(), fired: { r: { at: 1, unclearHalt: action } }, updatedAt: Date.now() };
        expect(createStateLedger(rawStore(JSON.stringify({ 7: record }))).get(7).state!.fired.r.unclearHalt).toBe(
            action,
        );
    });

    test('a non-object file is corrupt', () => {
        expect(createStateLedger(rawStore('[1,2]')).get(7).corrupt).toBe(true);
    });

    test.each([
        ['not an object', 'x'],
        ['missing phase', { ...initialState('Plan', 'a', 1), phase: 3 }],
        ['bad memory', { ...initialState('Plan', 'a', 1), memory: { held: 5 } }],
        ['bad inFlight', { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 'x' } }],
        [
            'bad inFlight marker',
            { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 1, unclear: 5 } },
        ],
        ['missing fired', { ...initialState('Plan', 'a', 1), fired: null }],
        ['a fired entry that is null', { ...initialState('Plan', 'a', 1), fired: { r: null } }],
        ['a fired entry that is not an object', { ...initialState('Plan', 'a', 1), fired: { r: 'x' } }],
        [
            'a stop after an action that is not a spend',
            { ...initialState('Plan', 'a', 1), fired: { r: { at: 1, unclearHalt: 'boost' } } },
        ],
        [
            'an inFlight marker that is not a spend',
            { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 1, unclear: 'boost' } },
        ],
        ['a spend count that is negative', { ...initialState('Plan', 'a', 1), spent: { swaps: -1 } }],
        ['a spend count that is not a number', { ...initialState('Plan', 'a', 1), spent: { swaps: 'x' } }],
        ['a spend count that is not finite', { ...initialState('Plan', 'a', 1), spent: { swaps: null } }],
        [
            'a marker time that is not a number',
            {
                ...initialState('Plan', 'a', 1),
                inFlight: { ruleId: 'r', actionIndex: 1, unclear: 'swap', unclearAt: 'x' },
            },
        ],
        ['bad history', { ...initialState('Plan', 'a', 1), history: [] }],
        ['bad outbox', { ...initialState('Plan', 'a', 1), outbox: {} }],
    ])('a malformed record (%s) is corrupt without affecting others', (label, record) => {
        const store = rawStore(JSON.stringify({ 7: record, 8: { ...state(), updatedAt: Date.now() } }));
        const ledger = createStateLedger(store);
        expect(ledger.get(7).corrupt).toBe(true);
        expect(ledger.get(8).state!.phase).toBe('buildup');
    });

    describe('an unreadable file is never replaced by one challenge’s change: it takes a reset of every challenge', () => {
        test('set writes nothing and keeps the state for later, and remove says the file is unreadable', () => {
            const store = rawStore('{not json');
            const ledger = createStateLedger(store);
            expect(ledger.set(7, state())).toBe(false);
            expect(ledger.hasUnsaved(7)).toBe(true);
            expect(ledger.remove(7)).toBe('unreadable');
            expect(store.writeRaw).not.toHaveBeenCalled();
            expect(store.raw).toBe('{not json');
        });

        test('removeAll clears it, every challenge’s state and every state waiting to be written', () => {
            const store = rawStore('{not json');
            const ledger = createStateLedger(store);
            ledger.set(7, state());
            expect(ledger.removeAll()).toBe('removed');
            expect(JSON.parse(store.raw!)).toEqual({});
            expect(ledger.hasUnsaved(7)).toBe(false);
            expect(ledger.get(7)).toEqual({ corrupt: false, state: null });
            expect(ledger.set(7, state())).toBe(true);
        });

        test('a readable file loses only the challenge removed, and removeAll loses them all', () => {
            const ledger = createMemoryStateLedger();
            ledger.set(7, state());
            ledger.set(8, state());
            expect(ledger.remove(7)).toBe('removed');
            expect(ledger.get(8).state).not.toBeNull();
            expect(ledger.removeAll()).toBe('removed');
            expect(ledger.get(8).state).toBeNull();
        });
    });

    test('remove forgets one challenge', () => {
        const ledger = createMemoryStateLedger();
        ledger.set(7, state());
        ledger.set(8, state());
        ledger.remove(7);
        expect(ledger.get(7).state).toBeNull();
        expect(ledger.get(8).state).not.toBeNull();
    });

    test('records older than 30 days are pruned on the next write', () => {
        const store = rawStore(
            JSON.stringify({ 7: { ...state(), updatedAt: Date.now() - 31 * 24 * 3600 * 1000 }, 9: 'junk' }),
        );
        const ledger = createStateLedger(store);
        ledger.set(8, state());
        expect(Object.keys(JSON.parse(store.raw!) as Record<string, unknown>)).toEqual(['8']);
    });

    test('parses once per stored text', () => {
        const store = rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } }));
        const ledger = createStateLedger(store);
        const parse = jest.spyOn(JSON, 'parse');
        ledger.get(7);
        ledger.get(7);
        // One parse of the file, plus structuredClone (not JSON) for the copies.
        expect(parse).toHaveBeenCalledTimes(1);
        parse.mockRestore();
    });
});

describe('the file’s changes are made under a lock across processes', () => {
    let clock = 0;
    beforeEach(() => {
        clock = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => clock);
        // Waiting moves the clock instead of the process: the bounded wait is then measured in steps.
        jest.spyOn(Atomics, 'wait').mockImplementation(() => {
            clock += 10;
            return 'timed-out';
        });
    });
    afterEach(() => jest.restoreAllMocks());

    // A lock registry two ledgers (two processes) share.
    const sharedLock = () => {
        let holder: string | null = null;
        const forWho = (who: string) =>
            jest.fn((_id: string) => {
                if (holder !== null && holder !== who) return { ok: false, release: () => {} };
                holder = who;
                return {
                    ok: true,
                    release: () => {
                        holder = null;
                    },
                };
            });
        return { forWho, take: (who: string) => (holder = who), free: () => (holder = null) };
    };

    test('two processes changing different challenges lose neither change: the second reads the file under the lock', () => {
        const store = rawStore();
        const lock = sharedLock();
        const first = createStateLedger(store, lock.forWho('first'));
        const second = createStateLedger(store, lock.forWho('second'));
        // The second is in the middle of its change when the first comes: the first waits for it, and then reads
        // the file as the second left it.
        lock.take('second');
        let waits = 0;
        jest.mocked(Atomics.wait).mockImplementation(() => {
            clock += 10;
            if (++waits === 3) {
                second.set(8, { ...state(), phase: 'second' });
                lock.take('second');
                lock.free();
            }
            return 'timed-out';
        });
        expect(first.set(7, { ...state(), phase: 'first' })).toBe(true);
        expect(Object.keys(JSON.parse(store.raw!) as Record<string, unknown>).sort()).toEqual(['7', '8']);
    });

    test('a lock that is not free in time fails the write safe: nothing is written, the state is kept and tried again', () => {
        const store = rawStore();
        const lock = sharedLock();
        const ledger = createStateLedger(store, lock.forWho('mine'));
        lock.take('other');
        expect(ledger.set(7, state())).toBe(false);
        expect(store.writeRaw).not.toHaveBeenCalled();
        // About half a second, in small steps.
        expect(jest.mocked(Atomics.wait).mock.calls.length).toBeGreaterThanOrEqual(40);
        expect(jest.mocked(Atomics.wait).mock.calls.length).toBeLessThanOrEqual(60);
        expect(invalid<() => CategoryLogger>(logger.withCategory)().warning).toHaveBeenCalledWith(
            'scenario state is locked by another process — nothing written',
            null,
        );
        // Until it is written the state is what the next read returns, and the writer knows it is waiting.
        expect(ledger.hasUnsaved(7)).toBe(true);
        expect(ledger.get(7)).toEqual({ corrupt: false, state: state() });
        expect(store.writeRaw).not.toHaveBeenCalled();
        lock.free();
        expect(ledger.get(7).state).toEqual({ ...state(), updatedAt: expect.any(Number) });
        expect(ledger.hasUnsaved(7)).toBe(false);
        expect(JSON.parse(store.raw!)).toEqual({ 7: expect.objectContaining({ phase: 'buildup' }) });
    });

    test('a reset waits for the lock too, and answers busy when it is not free', () => {
        const store = rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } }));
        const lock = sharedLock();
        const ledger = createStateLedger(store, lock.forWho('mine'));
        lock.take('other');
        expect(ledger.remove(7)).toBe('busy');
        expect(ledger.removeAll()).toBe('busy');
        expect(store.writeRaw).not.toHaveBeenCalled();
        lock.free();
        expect(ledger.remove(7)).toBe('removed');
    });

    test('the lock is let go whatever happens in the change, and a write that fails is a failed write, not a throw', () => {
        const store = rawStore();
        const release = jest.fn();
        const ledger = createStateLedger(
            store,
            jest.fn(() => ({ ok: true, release })),
        );
        jest.mocked(store.writeRaw).mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        expect(ledger.set(7, state())).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
        expect(invalid<() => CategoryLogger>(logger.withCategory)().error).toHaveBeenCalledWith(
            'scenario state could not be written: disk full',
            null,
        );
        expect(ledger.hasUnsaved(7)).toBe(true);
        expect(ledger.set(7, state())).toBe(true);
        expect(ledger.hasUnsaved(7)).toBe(false);
        expect(release).toHaveBeenCalledTimes(2);
    });
});

describe('module ledgers', () => {
    test('the persisted and mock ledgers are distinct', () => {
        expect(scenarioStateLedger).not.toBe(mockScenarioStateLedger);
        mockScenarioStateLedger.set(1, state());
        expect(mockScenarioStateLedger.get(1).state!.phase).toBe('buildup');
        mockScenarioStateLedger.remove(1);
    });

    test('the persisted ledger and the step lock take the cross-process lock, the file’s under its own key', () => {
        jest.mocked(fsModule.readdirSync).mockReturnValue([]);
        scenarioStateLedger.removeAll();
        expect(acquireUnlockLock).toHaveBeenCalledWith('scenariostate', 'scenario');
        expect(scenarioStepLock(7)).toEqual({ ok: true, release: expect.any(Function) });
        expect(acquireUnlockLock).toHaveBeenLastCalledWith('scenario-7', 'scenario');
    });

    test('exposes the Capacitor hydrate and flush hooks', async () => {
        await expect(initializeScenarioStateAsync()).resolves.toBeUndefined();
        await expect(flushScenarioStateWrites()).resolves.toBeUndefined();
    });
});

describe('the persisted file', () => {
    test('is replaced whole on every write (a reader never sees a cut-off file)', () => {
        const createJsonStore = jest.fn(() => ({
            readRaw: () => null,
            writeRaw: jest.fn(),
            initializeAsync: jest.fn(),
            refreshAsync: jest.fn(),
            flushPendingWrites: jest.fn(),
        }));
        jest.isolateModules(() => {
            jest.doMock('../src/ts/settings/storage', () => ({ createJsonStore }));
            require('../src/ts/scenarioStateStore');
        });
        expect(createJsonStore).toHaveBeenCalledWith({
            fileName: 'scenarioState.json',
            prefKey: 'gs_scenario_state',
            atomic: true,
        });
        jest.dontMock('../src/ts/settings/storage');
    });
});
