/**
 * Scenario runtime state ledger: per-challenge records, corruption reported
 * (never read as a fresh start), pruning, and the parse memo.
 */

const {
    createStateLedger,
    createMemoryStateLedger,
    initialState,
    scenarioStateLedger,
    mockScenarioStateLedger,
    initializeScenarioStateAsync,
    flushScenarioStateWrites,
} = require('../src/js/scenarioStateStore');
const logger = require('../src/js/logger');

jest.mock('../src/js/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => category) };
});

const rawStore = (initial = null) => {
    const store = {
        raw: initial,
        readRaw: jest.fn(() => store.raw),
        writeRaw: jest.fn((data) => {
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
        expect(read.memory).toEqual({ held: 'p1' });
        expect(read.updatedAt).toEqual(expect.any(Number));
        read.memory.held = 'changed';
        expect(ledger.get(7).state.memory.held).toBe('p1');
        expect(ledger.get(8).state).toBeNull();
    });

    test('an unreadable file is corrupt for every challenge, and logged once', () => {
        const ledger = createStateLedger(rawStore('{not json'));
        expect(ledger.get(7)).toEqual({ corrupt: true, state: null });
        expect(ledger.get(8)).toEqual({ corrupt: true, state: null });
        expect(logger.withCategory().error).toHaveBeenCalledTimes(1);
    });

    test('a non-object file is corrupt', () => {
        expect(createStateLedger(rawStore('[1,2]')).get(7).corrupt).toBe(true);
    });

    test.each([
        ['not an object', 'x'],
        ['missing phase', { ...initialState('Plan', 'a', 1), phase: 3 }],
        ['bad memory', { ...initialState('Plan', 'a', 1), memory: { held: 5 } }],
        ['bad inFlight', { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 'x' } }],
        ['missing fired', { ...initialState('Plan', 'a', 1), fired: null }],
        ['bad history', { ...initialState('Plan', 'a', 1), history: [] }],
    ])('a malformed record (%s) is corrupt without affecting others', (label, record) => {
        const store = rawStore(JSON.stringify({ 7: record, 8: { ...state(), updatedAt: Date.now() } }));
        const ledger = createStateLedger(store);
        expect(ledger.get(7).corrupt).toBe(true);
        expect(ledger.get(8).state.phase).toBe('buildup');
    });

    test('set and remove replace an unreadable file', () => {
        const store = rawStore('{not json');
        const ledger = createStateLedger(store);
        ledger.set(7, state());
        expect(ledger.get(7).state.phase).toBe('buildup');
        store.raw = '{not json';
        ledger.remove(7);
        expect(JSON.parse(store.raw)).toEqual({});
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
        expect(Object.keys(JSON.parse(store.raw))).toEqual(['8']);
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

describe('module ledgers', () => {
    test('the persisted and mock ledgers are distinct', () => {
        expect(scenarioStateLedger).not.toBe(mockScenarioStateLedger);
        mockScenarioStateLedger.set(1, state());
        expect(mockScenarioStateLedger.get(1).state.phase).toBe('buildup');
        mockScenarioStateLedger.remove(1);
    });

    test('exposes the Capacitor hydrate and flush hooks', async () => {
        await expect(initializeScenarioStateAsync()).resolves.toBeUndefined();
        await expect(flushScenarioStateWrites()).resolves.toBeUndefined();
    });
});
