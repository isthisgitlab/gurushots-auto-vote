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
    refreshScenarioStateAsync,
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
        expect(ledger.get(7)).toEqual({ corrupt: false, state: null, epoch: { all: 0, gen: 0 } });
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

    test('the steps of spends that got no answer or were written down first, marked on the rule in flight, are kept', () => {
        const ledger = createMemoryStateLedger();
        ledger.set(7, { ...state(), inFlight: { ruleId: 'r1', actionIndex: 1, unclear: ['swap', 'unlockBoost'] } });
        expect(ledger.get(7).state!.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            unclear: ['swap', 'unlockBoost'],
        });
        const raw = rawStore(
            JSON.stringify({
                7: {
                    ...state(),
                    inFlight: { ruleId: 'r1', actionIndex: 1, unclear: ['swap'], pending: 'fillExposure' },
                },
            }),
        );
        expect(createStateLedger(raw).get(7).state!.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            unclear: ['swap'],
            pending: 'fillExposure',
        });
    });

    test('an unreadable file is corrupt for every challenge, and logged once', () => {
        const ledger = createStateLedger(rawStore('{not json'));
        expect(ledger.get(7)).toMatchObject({ corrupt: 'file', state: null });
        expect(ledger.get(8)).toMatchObject({ corrupt: 'file', state: null });
        expect(invalid<() => CategoryLogger>(logger.withCategory)().error).toHaveBeenCalledTimes(1);
    });

    test('a file with nothing in it was cut short: it is corrupt, never "no state" that the next write replaces', () => {
        const store = rawStore('');
        const ledger = createStateLedger(store);
        expect(ledger.get(7)).toMatchObject({ corrupt: 'file', state: null });
        expect(createStateLedger(rawStore('  \n')).get(7).corrupt).toBe('file');
        expect(store.writeRaw).not.toHaveBeenCalled();
    });

    test.each(['swap', 'unlockBoost', 'fillExposure'])('a rule stopped after %s is read as stopped', (action) => {
        const record = { ...state(), fired: { r: { at: 1, unclearHalt: action } }, updatedAt: Date.now() };
        expect(createStateLedger(rawStore(JSON.stringify({ 7: record }))).get(7).state!.fired.r.unclearHalt).toBe(
            action,
        );
    });

    test('a non-object file is corrupt', () => {
        expect(createStateLedger(rawStore('[1,2]')).get(7).corrupt).toBe('file');
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
        [
            'an inFlight marker that is a single action, not a list',
            { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 1, unclear: 'swap' } },
        ],
        [
            'a pending marker that is not a spend',
            { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 1, pending: 'boost' } },
        ],
        [
            'a halt origin that is not one',
            { ...initialState('Plan', 'a', 1), fired: { r: { at: 1, unclearHalt: 'swap', haltOrigin: 'x' } } },
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
            { ...initialState('Plan', 'a', 1), inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['boost'] } },
        ],
        ['a spend count that is negative', { ...initialState('Plan', 'a', 1), spent: { swaps: -1 } }],
        ['a spend count that is not a number', { ...initialState('Plan', 'a', 1), spent: { swaps: 'x' } }],
        ['a spend count that is not finite', { ...initialState('Plan', 'a', 1), spent: { swaps: null } }],
        [
            'a marker time that is not a number',
            {
                ...initialState('Plan', 'a', 1),
                inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['swap'], unclearAt: 'x' },
            },
        ],
        ['bad history', { ...initialState('Plan', 'a', 1), history: [] }],
        ['bad outbox', { ...initialState('Plan', 'a', 1), outbox: {} }],
        ['a photo’s history that is not a list', { ...initialState('Plan', 'a', 1), history: { 9: {} } }],
        ['a sample that is not a pair', { ...initialState('Plan', 'a', 1), history: { 9: [[1, 2, 3]] } }],
        ['a sample that is not numbers', { ...initialState('Plan', 'a', 1), history: { 9: [[1, 'x']] } }],
        ['a notice that is not an object', { ...initialState('Plan', 'a', 1), outbox: ['x'] }],
        ['a notice without a message', { ...initialState('Plan', 'a', 1), outbox: [{ id: 'a', at: 1 }] }],
        [
            'a notice with a time that is not a number',
            { ...initialState('Plan', 'a', 1), outbox: [{ id: 'a', at: 'x', message: 'm' }] },
        ],
        ['a count of resets that is not a number', { ...initialState('Plan', 'a', 1), gen: 'x' }],
    ])(
        'a malformed record (%s) is corrupt, as a record and not as a file, without affecting others',
        (label, record) => {
            const store = rawStore(JSON.stringify({ 7: record, 8: { ...state(), updatedAt: Date.now() } }));
            const ledger = createStateLedger(store);
            expect(ledger.get(7)).toMatchObject({ corrupt: 'record', state: null });
            expect(ledger.get(8).state!.phase).toBe('buildup');
        },
    );

    describe('an unreadable file is never replaced by one challenge’s change: it takes a reset of every challenge', () => {
        test('set writes nothing, and remove says the file is unreadable', async () => {
            const store = rawStore('{not json');
            const ledger = createStateLedger(store);
            expect(ledger.set(7, state())).toBe('failed');
            await expect(ledger.remove(7)).resolves.toBe('unreadable');
            expect(store.writeRaw).not.toHaveBeenCalled();
            expect(store.raw).toBe('{not json');
        });

        test('removeAll clears it, and every challenge starts again', async () => {
            const store = rawStore('{not json');
            const ledger = createStateLedger(store);
            await expect(ledger.removeAll()).resolves.toBe('removed');
            expect(ledger.get(7)).toMatchObject({ corrupt: false, state: null });
            expect(ledger.set(7, state())).toBe('saved');
        });

        test('a readable file loses only the challenge removed, and removeAll loses them all', async () => {
            const ledger = createMemoryStateLedger();
            ledger.set(7, state());
            ledger.set(8, state());
            await expect(ledger.remove(7)).resolves.toBe('removed');
            expect(ledger.get(8).state).not.toBeNull();
            await expect(ledger.removeAll()).resolves.toBe('removed');
            expect(ledger.get(8).state).toBeNull();
        });

        test('a bad record of one challenge is reset by that challenge alone, the rest of the file untouched', async () => {
            const store = rawStore(
                JSON.stringify({ 7: { ...state(), phase: 3 }, 8: { ...state(), updatedAt: Date.now() } }),
            );
            const ledger = createStateLedger(store);
            expect(ledger.get(7).corrupt).toBe('record');
            await expect(ledger.remove(7)).resolves.toBe('removed');
            expect(ledger.get(7)).toMatchObject({ corrupt: false, state: null });
            expect(ledger.get(8).state!.phase).toBe('buildup');
        });
    });

    test('remove forgets one challenge', async () => {
        const ledger = createMemoryStateLedger();
        ledger.set(7, state());
        ledger.set(8, state());
        await ledger.remove(7);
        expect(ledger.get(7).state).toBeNull();
        expect(ledger.get(8).state).not.toBeNull();
    });

    describe('what is pruned on a write', () => {
        const OLD = Date.now() - 31 * 24 * 3600 * 1000;
        const kept = (store: ReturnType<typeof rawStore>) =>
            Object.keys(JSON.parse(store.raw!) as Record<string, unknown>).sort();

        test('records and tombstones older than 30 days go; fresh ones, and the count of every reset, stay', () => {
            const store = rawStore(
                JSON.stringify({
                    7: { ...state(), updatedAt: OLD },
                    9: { tombstone: true, gen: 3, updatedAt: OLD },
                    10: { ...state(), updatedAt: Date.now() },
                    11: { tombstone: true, gen: 3, updatedAt: Date.now() },
                    '@all': 5,
                }),
            );
            createStateLedger(store).set(8, state());
            expect(kept(store)).toEqual(['10', '11', '8', '@all']);
        });

        test('a record that still holds a spend not known to have been made, or a stopped rule, is kept until it is reset', async () => {
            const fresh = Date.now();
            const store = rawStore(
                JSON.stringify({
                    1: { ...state(), updatedAt: OLD, inFlight: { ruleId: 'r', actionIndex: 0, unclear: ['swap'] } },
                    2: { ...state(), updatedAt: OLD, inFlight: { ruleId: 'r', actionIndex: 0, pending: 'swap' } },
                    3: { ...state(), updatedAt: OLD, fired: { r: { at: 1, unclearHalt: 'swap' } } },
                    4: { ...state(), updatedAt: OLD, fired: { r: { at: 1 } } },
                    5: { ...state(), updatedAt: OLD, inFlight: { ruleId: 'r', actionIndex: 0 } },
                    6: { ...state(), updatedAt: fresh },
                }),
            );
            const ledger = createStateLedger(store);
            ledger.set(8, state());
            // Those that guard against a second spend stay; an old record that guards nothing goes.
            expect(kept(store)).toEqual(['1', '2', '3', '6', '8']);
            await ledger.remove(1);
            ledger.set(8, state());
            expect(kept(store)).toEqual(['1', '2', '3', '6', '8']);
            expect((JSON.parse(store.raw!) as Record<string, unknown>)['1']).toMatchObject({ tombstone: true });
        });

        test('what cannot be read is not deleted by the write of another challenge: it is for its user to reset', async () => {
            const store = rawStore(
                JSON.stringify({ 7: { ...state(), phase: 3, updatedAt: OLD }, 9: 'junk', 12: { tombstone: true } }),
            );
            const ledger = createStateLedger(store);
            ledger.set(8, state());
            expect(kept(store)).toEqual(['12', '7', '8', '9']);
            expect(ledger.get(7).corrupt).toBe('record');
            // …until its own reset.
            await ledger.remove(7);
            expect(ledger.get(7)).toMatchObject({ corrupt: false, state: null });
        });
    });

    test('a count at the edge of what can be counted is not one: it reads as none, and the next reset moves past it', async () => {
        const store = rawStore(
            JSON.stringify({ '@all': 2 ** 53, 7: { tombstone: true, gen: 2 ** 53 + 2, updatedAt: Date.now() } }),
        );
        const ledger = createStateLedger(store);
        expect(ledger.get(7).epoch).toEqual({ all: 0, gen: 0 });
        await ledger.remove(7);
        await ledger.removeAll();
        const { epoch } = ledger.get(7);
        expect(Number.isSafeInteger(epoch.all) && epoch.all > 0).toBe(true);
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
        expect(first.set(7, { ...state(), phase: 'first' })).toBe('saved');
        expect(Object.keys(JSON.parse(store.raw!) as Record<string, unknown>).sort()).toEqual(['7', '8']);
    });

    test('a lock that is not free in time fails the write safe: nothing is written', () => {
        const store = rawStore();
        const lock = sharedLock();
        const ledger = createStateLedger(store, lock.forWho('mine'));
        lock.take('other');
        expect(ledger.set(7, state())).toBe('failed');
        expect(store.writeRaw).not.toHaveBeenCalled();
        // About half a second, in small steps.
        expect(jest.mocked(Atomics.wait).mock.calls.length).toBeGreaterThanOrEqual(40);
        expect(jest.mocked(Atomics.wait).mock.calls.length).toBeLessThanOrEqual(60);
        expect(invalid<() => CategoryLogger>(logger.withCategory)().warning).toHaveBeenCalledWith(
            'scenario state is locked by another process — nothing written',
            null,
        );
        // It is not kept anywhere: what was not written is not state (the write-ahead marker is what guards a spend).
        expect(ledger.get(7).state).toBeNull();
        lock.free();
        expect(ledger.set(7, state())).toBe('saved');
        expect(JSON.parse(store.raw!)).toEqual({ 7: expect.objectContaining({ phase: 'buildup' }) });
    });

    test('a read neither waits for the lock nor takes it, whoever holds it', () => {
        const store = rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } }));
        const lock = sharedLock();
        const acquire = lock.forWho('mine');
        const ledger = createStateLedger(store, acquire);
        lock.take('other');
        expect(ledger.get(7).state).not.toBeNull();
        expect(acquire).not.toHaveBeenCalled();
        expect(Atomics.wait).not.toHaveBeenCalled();
    });

    test('a reset waits for the lock too, and answers busy when it is not free', async () => {
        const store = rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } }));
        const lock = sharedLock();
        const ledger = createStateLedger(store, lock.forWho('mine'));
        lock.take('other');
        await expect(ledger.remove(7)).resolves.toBe('busy');
        await expect(ledger.removeAll()).resolves.toBe('busy');
        expect(store.writeRaw).not.toHaveBeenCalled();
        lock.free();
        await expect(ledger.remove(7)).resolves.toBe('removed');
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
        expect(ledger.set(7, state())).toBe('failed');
        expect(release).toHaveBeenCalledTimes(1);
        expect(invalid<() => CategoryLogger>(logger.withCategory)().error).toHaveBeenCalledWith(
            'scenario state could not be written: disk full',
            null,
        );
        expect(ledger.set(7, state())).toBe('saved');
        expect(release).toHaveBeenCalledTimes(2);
    });
});

describe('a state is written only over the record it was read from', () => {
    // Two ledgers over one file: two processes whose step lock one of them lost.
    const twoOver = (store = rawStore()) => ({ store, a: createStateLedger(store), b: createStateLedger(store) });
    const warned = () => invalid<() => CategoryLogger>(logger.withCategory)().warning;

    test('a state whose record another process changed since it was read is refused, and the other change stays', () => {
        const { a, b } = twoOver();
        a.set(7, state());
        const mine = a.get(7).state!;
        const theirs = b.get(7).state!;
        expect(b.set(7, { ...theirs, phase: 'theirs' })).toBe('saved');
        expect(a.set(7, { ...mine, phase: 'mine' })).toBe('refused');
        expect(a.get(7).state!.phase).toBe('theirs');
        expect(warned()).toHaveBeenCalledWith(
            'scenario state of challenge 7 was changed by another process meanwhile — not written',
            null,
        );
    });

    test('a write-ahead marker is refused the same way, so a step does not spend over the other process’s marker', () => {
        const { a, b } = twoOver();
        a.set(7, state());
        const mine = a.get(7).state!;
        const theirs = b.get(7).state!;
        const marker = (from: typeof mine) => ({
            ...from,
            inFlight: { ruleId: 'r', actionIndex: 0, pending: 'swap' as const },
        });
        expect(b.set(7, marker(theirs))).toBe('saved');
        expect(a.set(7, marker(mine))).toBe('refused');
    });

    test('the writer’s own successive writes go on from what it wrote, and a state derived from the read keeps its place', () => {
        const { a } = twoOver();
        a.set(7, state());
        const read = a.get(7).state!;
        expect(a.set(7, { ...read, phase: 'one' })).toBe('saved');
        expect(a.set(7, { ...read, phase: 'two' })).toBe('saved');
        expect(a.set(7, { ...read, phase: 'two', lastError: { at: 1, message: 'x' } })).toBe('saved');
        expect(a.get(7).state!.phase).toBe('two');
    });

    test('a first write over no record is refused when another process has made one since', () => {
        const { a, b } = twoOver();
        const { state: none, epoch } = a.get(7);
        expect(none).toBeNull();
        expect(b.set(7, state())).toBe('saved');
        expect(a.set(7, { ...state(), epoch })).toBe('refused');
        expect(a.get(7).state).not.toBeNull();
    });

    test('a failed write leaves its place as it was, and a state that was not read from the ledger is not compared', () => {
        const { a, store } = twoOver();
        a.set(7, state());
        const read = a.get(7).state!;
        jest.mocked(store.writeRaw).mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        expect(a.set(7, { ...read, phase: 'x' })).toBe('failed');
        expect(a.set(7, { ...read, phase: 'y' })).toBe('saved');
        // No epoch: nothing to be compared against.
        expect(a.set(7, { ...state(), phase: 'z' })).toBe('saved');
    });
});

describe('a reset is not undone by what was running when it was made', () => {
    // Two ledgers over one file: two processes (the app and the CLI), or a step and a reset in the one.
    const twoOver = (store = rawStore()) => ({ store, a: createStateLedger(store), b: createStateLedger(store) });

    test('a state read before a reset of its challenge is not written back, and the reset stays', async () => {
        const { a, b } = twoOver();
        a.set(7, state());
        const running = a.get(7).state!;
        await expect(b.remove(7)).resolves.toBe('removed');
        expect(a.set(7, { ...running, phase: 'old progress' })).toBe('refused');
        expect(a.get(7)).toMatchObject({ corrupt: false, state: null });
        expect(invalid<() => CategoryLogger>(logger.withCategory)().warning).toHaveBeenCalledWith(
            'scenario state of challenge 7 was reset meanwhile — not written',
            null,
        );
    });

    test('a state read before a reset of every challenge is not written back either, for any challenge', async () => {
        const { a, b } = twoOver();
        a.set(7, state());
        a.set(8, state());
        const first = a.get(7).state!;
        const second = a.get(8).state!;
        await expect(b.removeAll()).resolves.toBe('removed');
        expect(a.set(7, first)).toBe('refused');
        expect(a.set(8, second)).toBe('refused');
        expect(a.get(7).state).toBeNull();
        // What is read after it is under the new count, and is written.
        const fresh = a.get(7);
        expect(a.set(7, { ...state(), epoch: fresh.epoch })).toBe('saved');
    });

    test('a reset of one challenge leaves the steps of the others running', async () => {
        const { a, b } = twoOver();
        a.set(7, state());
        a.set(8, state());
        const other = a.get(8).state!;
        await b.remove(7);
        expect(a.set(8, { ...other, phase: 'moved on' })).toBe('saved');
        expect(a.get(8).state!.phase).toBe('moved on');
    });

    test('a plan that was being started when its challenge was reset does not start from before the reset', async () => {
        const { a, b } = twoOver();
        const { epoch } = a.get(7);
        await b.remove(7);
        expect(a.set(7, { ...state(), epoch })).toBe('refused');
    });

    test('a reset is counted as a reset even where the earlier count is not to be read, and counts keep rising', async () => {
        const store = rawStore(
            JSON.stringify({ 7: { tombstone: true, gen: 'x', updatedAt: Date.now() }, '@all': 'x' }),
        );
        const ledger = createStateLedger(store);
        const before = ledger.get(7);
        expect(before.epoch).toEqual({ all: 0, gen: 0 });
        await ledger.remove(7);
        await ledger.removeAll();
        const after = ledger.get(7).epoch;
        expect(after.all).toBeGreaterThan(0);
        await ledger.remove(7);
        expect(ledger.get(7).epoch.gen).toBeGreaterThan(after.gen);
    });

    test('a reset of every challenge keeps its count through a write, and a count is not written into a state', async () => {
        const { store, a } = twoOver();
        await a.removeAll();
        a.set(7, { ...state(), epoch: a.get(7).epoch });
        const written = JSON.parse(store.raw!) as Record<string, Record<string, unknown>>;
        expect(written['@all']).toEqual(expect.any(Number));
        expect(written['7']).toHaveProperty('gen', 0);
        expect(written['7']).not.toHaveProperty('epoch');
    });

    test('no lock is needed for it: a store with no other process to lock against (Android, Capacitor) refuses the same', async () => {
        const store = rawStore();
        const ledger = createStateLedger(store);
        ledger.set(7, state());
        const running = ledger.get(7).state!;
        await ledger.removeAll();
        expect(ledger.set(7, running)).toBe('refused');
    });
});

describe('on Android a reset is asked for, never written into a file the service may have written since', () => {
    const g = globalThis as typeof globalThis & { Capacitor?: unknown; __GS_HEADLESS__?: boolean };
    afterEach(() => {
        delete g.Capacitor;
        delete g.__GS_HEADLESS__;
    });
    const asApp = () => {
        g.Capacitor = { isNativePlatform: () => true };
        delete g.__GS_HEADLESS__;
    };
    const asService = () => {
        delete g.Capacitor;
        g.__GS_HEADLESS__ = true;
    };
    // The app's ledger and the background service's, over the one stored file and the one store of requests.
    const both = (main = rawStore(), asked = rawStore()) => ({
        main,
        asked,
        app: createStateLedger(main, undefined, asked),
        service: createStateLedger(main, undefined, asked),
    });
    const requestsOf = (store: ReturnType<typeof rawStore>) => JSON.parse(store.raw!) as Record<string, number>;

    test('the app writes the request and leaves the file alone; the service sees the reset when it reads', async () => {
        const { main, asked, app, service } = both();
        asService();
        service.set(7, state());
        service.set(8, state());
        asApp();
        const before = main.raw;
        await expect(app.remove(7)).resolves.toBe('removed');
        expect(main.raw).toBe(before);
        expect(requestsOf(asked)).toEqual({ 7: expect.any(Number) });
        // The app's own reads apply it too.
        expect(app.get(7)).toMatchObject({ corrupt: false, state: null });
        expect(app.get(8).state).not.toBeNull();
        asService();
        expect(service.get(7)).toMatchObject({ corrupt: false, state: null });
    });

    test('a step of the service that was running is refused after the reset, and its next write carries the reset into the file', async () => {
        const { main, app, service } = both();
        asService();
        service.set(7, state());
        const running = service.get(7).state!;
        service.set(8, state());
        asApp();
        await app.remove(7);
        asService();
        expect(service.set(7, { ...running, phase: 'old progress' })).toBe('refused');
        // Another challenge's write is made on the file as it reads with the reset applied: no other progress is lost.
        expect(service.set(8, { ...service.get(8).state!, phase: 'moved on' })).toBe('saved');
        const written = JSON.parse(main.raw!) as Record<string, Record<string, unknown>>;
        expect(written['7']).toMatchObject({ tombstone: true });
        expect(written['8']).toMatchObject({ phase: 'moved on' });
    });

    test('a reset of every challenge is asked for the same way, and applied once', async () => {
        const { main, asked, app, service } = both();
        asService();
        service.set(7, state());
        asApp();
        await expect(app.removeAll()).resolves.toBe('removed');
        expect(Object.keys(requestsOf(asked))).toEqual(['@all']);
        expect(app.get(7).state).toBeNull();
        asService();
        const afterReset = service.get(7);
        expect(afterReset.state).toBeNull();
        expect(service.set(7, { ...state(), epoch: afterReset.epoch })).toBe('saved');
        // The request stays where it was asked, and is not applied again over what was written since.
        expect(service.get(7).state).not.toBeNull();
        expect(JSON.parse(main.raw!)).toHaveProperty('7');
    });

    describe('requests do not outlive what they asked for, and do not make it again', () => {
        const OLD = Date.now() - 31 * 24 * 3600 * 1000;

        test('a request older than a tombstone is kept for is ignored, so a pruned tombstone is not made again', () => {
            const { main, asked, app } = both(
                rawStore(JSON.stringify({ 8: { ...state(), updatedAt: Date.now() } })),
                rawStore(JSON.stringify({ 7: OLD })),
            );
            asApp();
            expect(app.get(7)).toMatchObject({ corrupt: false, state: null, epoch: { all: 0, gen: 0 } });
            expect(app.set(8, { ...app.get(8).state!, phase: 'moved on' })).toBe('saved');
            expect(Object.keys(JSON.parse(main.raw!) as Record<string, unknown>)).toEqual(['8']);
            expect(asked.writeRaw).not.toHaveBeenCalled();
        });

        test('a request that is not applied yet to a record that still stands does not age out: that reset is not undone', async () => {
            const { asked, app } = both(
                rawStore(
                    JSON.stringify({
                        7: {
                            ...state(),
                            updatedAt: OLD,
                            inFlight: { ruleId: 'r', actionIndex: 0, unclear: ['swap'] },
                        },
                        8: { ...state(), updatedAt: Date.now() },
                    }),
                ),
                rawStore(JSON.stringify({ 7: OLD + 1000 })),
            );
            asApp();
            // The record holds a stop, so it was never pruned; the reset asked for it long ago still applies.
            expect(app.get(7)).toMatchObject({ corrupt: false, state: null });
            expect(app.get(8).state).not.toBeNull();
            // The record still holds its stop in the file, so the request is kept when the app asks for another reset.
            await app.remove(9);
            expect(Object.keys(requestsOf(asked)).sort()).toEqual(['7', '9']);
            expect(app.get(7)).toMatchObject({ corrupt: false, state: null });
        });

        test('a reset of every challenge asked for long ago is kept while a record stands that it was not applied to', async () => {
            const { asked, app } = both(
                rawStore(JSON.stringify({ 8: { ...state(), updatedAt: Date.now() } })),
                rawStore(JSON.stringify({ '@all': OLD })),
            );
            asApp();
            expect(app.get(8).state).toBeNull();
            await app.remove(9);
            expect(Object.keys(requestsOf(asked)).sort()).toEqual(['9', '@all']);
        });

        test('a reset of every challenge asked for long ago goes when no record is left for it to apply to', async () => {
            const { asked, app } = both(
                rawStore(JSON.stringify({ '@all': OLD - 1000 })),
                rawStore(JSON.stringify({ '@all': OLD })),
            );
            asApp();
            await app.remove(9);
            expect(Object.keys(requestsOf(asked))).toEqual(['9']);
        });

        test('what a recent request makes ages from when it was asked, not from when it was seen', () => {
            const recent = Date.now() - 29 * 24 * 3600 * 1000;
            const { main, app, service } = both(rawStore(), rawStore(JSON.stringify({ 7: recent })));
            asService();
            service.set(8, state());
            expect((JSON.parse(main.raw!) as Record<string, Record<string, unknown>>)['7']).toEqual({
                tombstone: true,
                gen: recent,
                updatedAt: recent,
            });
            asApp();
            expect(app.get(7).epoch.gen).toBe(recent);
        });

        test('the app drops the requests that have aged out when it asks for another', async () => {
            const { asked, app } = both(rawStore(), rawStore(JSON.stringify({ 7: OLD, 9: Date.now() })));
            asApp();
            await app.remove(8);
            expect(Object.keys(requestsOf(asked)).sort()).toEqual(['8', '9']);
        });
    });

    test('a second reset of the same challenge counts past the first', async () => {
        const { asked, app } = both();
        asApp();
        await app.remove(7);
        const first = requestsOf(asked)['7'];
        await app.remove(7);
        expect(requestsOf(asked)['7']).toBeGreaterThan(first);
    });

    test('a file that cannot be read is cleared by the app itself, as there is nothing to lose in it', async () => {
        const { main, asked, app } = both(rawStore('{not json'));
        asApp();
        await expect(app.remove(7)).resolves.toBe('unreadable');
        expect(asked.writeRaw).not.toHaveBeenCalled();
        await expect(app.removeAll()).resolves.toBe('removed');
        expect(JSON.parse(main.raw!)).toEqual({ '@all': expect.any(Number) });
        expect(asked.writeRaw).not.toHaveBeenCalled();
    });

    test('where resets are made on the file (the desktop apps), a store of requests, if given, is not used', async () => {
        const { main, asked, app } = both();
        app.set(7, state());
        await expect(app.remove(7)).resolves.toBe('removed');
        expect(asked.writeRaw).not.toHaveBeenCalled();
        expect((JSON.parse(main.raw!) as Record<string, unknown>)['7']).toMatchObject({ tombstone: true });
    });

    test('requests that are no JSON, or carry no counts, ask for nothing', () => {
        const { app } = both(rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } })), rawStore('{no'));
        asApp();
        expect(app.get(7).state).not.toBeNull();
        const other = createStateLedger(
            rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } })),
            undefined,
            rawStore(JSON.stringify({ 7: 'x', '@all': -1 })),
        );
        expect(other.get(7).state).not.toBeNull();
        const array = createStateLedger(
            rawStore(JSON.stringify({ 7: { ...state(), updatedAt: Date.now() } })),
            undefined,
            rawStore('[1]'),
        );
        expect(array.get(7).state).not.toBeNull();
    });
});

describe('a reset is saved before anything can read it', () => {
    const g = globalThis as typeof globalThis & { Capacitor?: unknown };
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });
    afterEach(() => {
        delete g.Capacitor;
    });
    // A store whose writes are saved before they show, and that can be made to refuse them.
    const throughStore = (initial: string | null = null) => {
        const refuse = { next: false };
        // What shows up in the store while a write waits for its turn.
        const meanwhile: { raw: string | null } = { raw: null };
        const base = rawStore(initial);
        const store = Object.assign(base, {
            updateThrough: jest.fn(async (update: (current: string | null) => string | null) => {
                if (refuse.next) {
                    refuse.next = false;
                    return 'failed' as const;
                }
                if (meanwhile.raw !== null) base.raw = meanwhile.raw;
                const data = update(base.raw);
                if (data === null) return 'aborted' as const;
                base.raw = data;
                return 'saved' as const;
            }),
        });
        return { store, refuse, meanwhile };
    };
    const live = JSON.stringify({ 7: { ...state(), updatedAt: Date.now() }, 8: { ...state(), updatedAt: Date.now() } });

    test('one that could not be saved is not applied by the next read, and the next reset does not carry it', async () => {
        const main = rawStore(live);
        const { store: asked, refuse } = throughStore();
        const app = createStateLedger(main, undefined, asked);
        refuse.next = true;
        await expect(app.remove(7)).resolves.toBe('not-saved');
        expect(asked.raw).toBeNull();
        expect(app.get(7).state).not.toBeNull();
        await expect(app.remove(8)).resolves.toBe('removed');
        expect(Object.keys(JSON.parse(asked.raw!) as object)).toEqual(['8']);
        expect(app.get(7).state).not.toBeNull();
        expect(app.get(8).state).toBeNull();
    });

    test('is made from the requests as they stand when its turn comes, not as they were when it was asked', async () => {
        const main = rawStore(live);
        const { store: asked } = throughStore();
        const app = createStateLedger(main, undefined, asked);
        const first = app.remove(7);
        const second = app.remove(8);
        await Promise.all([first, second]);
        expect(asked.updateThrough).toHaveBeenCalledTimes(2);
        asked.raw = JSON.stringify({ 7: Date.now() });
        const update = asked.updateThrough.mock.calls[1][0];
        expect(Object.keys(JSON.parse(update(asked.raw) ?? '{}') as object).sort()).toEqual(['7', '8']);
    });

    test('is the same change when made again on a newer value: the count it asks for is worked out once', async () => {
        const main = rawStore(live);
        const { store: asked } = throughStore();
        const app = createStateLedger(main, undefined, asked);
        await app.remove(7);
        const update = asked.updateThrough.mock.calls[0][0];
        const now = jest.spyOn(Date, 'now');
        try {
            now.mockReturnValue(Date.now() + 10_000);
            const first = JSON.parse(update(null) ?? '{}') as Record<string, number>;
            now.mockReturnValue(Date.now() + 50_000);
            const again = JSON.parse(update(JSON.stringify({ 8: Date.now() })) ?? '{}') as Record<string, number>;
            expect(again[7]).toBe(first[7]);
            expect(again[8]).toEqual(expect.any(Number));
        } finally {
            now.mockRestore();
        }
    });

    test('of every challenge, on a file that cannot be read, is written into the file only once it is saved', async () => {
        const { store: main, refuse } = throughStore('{no');
        const app = createStateLedger(main, undefined, rawStore());
        refuse.next = true;
        await expect(app.removeAll()).resolves.toBe('not-saved');
        expect(main.raw).toBe('{no');
        expect(app.get(7).corrupt).toBe('file');
        await expect(app.removeAll()).resolves.toBe('removed');
        expect(app.get(7).corrupt).toBe(false);
    });

    test('of every challenge, asked for only while the file cannot be read, leaves one that reads again alone', async () => {
        const main = rawStore(live);
        const { store: asked } = throughStore();
        const app = createStateLedger(main, undefined, asked);
        await expect(app.removeAll(true)).resolves.toBe('readable');
        expect(main.writeRaw).not.toHaveBeenCalled();
        expect(app.get(7).state).not.toBeNull();
        // The same ledger, once the file cannot be read, makes it.
        main.raw = '{no';
        await expect(app.removeAll(true)).resolves.toBe('removed');
        expect(app.get(7).corrupt).toBe(false);
    });

    test('of every challenge, asked for only while the file cannot be read, is not held up by a lock when the file reads', async () => {
        delete g.Capacitor;
        const file = rawStore(live);
        const held = jest.fn((_id: string) => ({ ok: false, release: () => {} }));
        const desktop = createStateLedger(file, held);
        await expect(desktop.removeAll(true)).resolves.toBe('readable');
        expect(held).not.toHaveBeenCalled();
        expect(file.writeRaw).not.toHaveBeenCalled();
    });

    test('of every challenge, asked for only while the file cannot be read, decides on the file as it is where the write is made', async () => {
        // The Android write waits for its turn, and the file reads again by then.
        const { store: main, meanwhile } = throughStore('{no');
        const app = createStateLedger(main, undefined, rawStore());
        meanwhile.raw = live;
        await expect(app.removeAll(true)).resolves.toBe('readable');
        expect(main.raw).toBe(live);
        // The desktop's waits for the lock, and the file reads again by then.
        const file = rawStore('{no');
        const acquire = jest.fn((_id: string) => {
            file.raw = live;
            return { ok: true, release: () => {} };
        });
        delete g.Capacitor;
        const desktop = createStateLedger(file, acquire);
        await expect(desktop.removeAll(true)).resolves.toBe('readable');
        expect(file.writeRaw).not.toHaveBeenCalled();
        expect(file.raw).toBe(live);
    });

    test('is not made at all while the saved progress was never loaded, and every challenge reads as paused', async () => {
        const main = rawStore(live);
        const { store: asked } = throughStore();
        const app = createStateLedger(main, undefined, asked, () => false);
        expect(app.get(7)).toMatchObject({ corrupt: 'unloaded', state: null });
        expect(app.set(7, state())).toBe('failed');
        await expect(app.remove(7)).resolves.toBe('unloaded');
        await expect(app.removeAll()).resolves.toBe('unloaded');
        await expect(app.removeAll(true)).resolves.toBe('unloaded');
        expect(asked.updateThrough).not.toHaveBeenCalled();
        expect(main.writeRaw).not.toHaveBeenCalled();
    });

    test('reads again once what is saved was loaded', async () => {
        let loaded = false;
        const app = createStateLedger(rawStore(live), undefined, rawStore(), () => loaded);
        expect(app.get(7).corrupt).toBe('unloaded');
        loaded = true;
        expect(app.get(7)).toMatchObject({ corrupt: false });
        expect(app.get(7).state).not.toBeNull();
    });

    test('on the desktop it is made on the file itself, and the requests are never read', async () => {
        delete g.Capacitor;
        const main = rawStore(live);
        const asked = throughStore();
        const desktop = createStateLedger(main, undefined, asked.store);
        await expect(desktop.remove(7)).resolves.toBe('removed');
        expect(asked.store.readRaw).not.toHaveBeenCalled();
        expect(asked.store.updateThrough).not.toHaveBeenCalled();
    });
});

describe('a lock the app cannot make at all is not a lock held by another', () => {
    const unavailable = () => ({ ok: false, release: () => {}, unavailable: true as const });

    test('a write, and each reset, say so instead of "busy", at once, and write nothing', async () => {
        const store = rawStore();
        const acquire = jest.fn((_id: string) => unavailable());
        const ledger = createStateLedger(store, acquire);
        expect(ledger.set(7, state())).toBe('failed');
        await expect(ledger.remove(7)).resolves.toBe('unavailable');
        await expect(ledger.removeAll()).resolves.toBe('unavailable');
        expect(store.writeRaw).not.toHaveBeenCalled();
        // No waiting for a lock that will not come.
        expect(acquire).toHaveBeenCalledTimes(3);
        expect(invalid<() => CategoryLogger>(logger.withCategory)().error).toHaveBeenCalledWith(
            'the app cannot create its lock files in its data folder — scenario state not written',
            null,
        );
    });
});

describe('module ledgers', () => {
    test('the persisted and mock ledgers are distinct', async () => {
        expect(scenarioStateLedger).not.toBe(mockScenarioStateLedger);
        mockScenarioStateLedger.set(1, state());
        expect(mockScenarioStateLedger.get(1).state!.phase).toBe('buildup');
        await mockScenarioStateLedger.remove(1);
    });

    test('the persisted ledger and the step lock take the cross-process lock, the file’s under its own key', async () => {
        jest.mocked(fsModule.readdirSync).mockReturnValue([]);
        await scenarioStateLedger.removeAll();
        expect(acquireUnlockLock).toHaveBeenCalledWith('scenariostate', { category: 'scenario', internal: true });
        expect(scenarioStepLock(7)).toEqual({ ok: true, release: expect.any(Function) });
        expect(acquireUnlockLock).toHaveBeenLastCalledWith('scenario-7', { category: 'scenario', internal: true });
    });

    test('exposes the Capacitor hydrate, refresh and flush hooks, for the state and the resets asked for', async () => {
        await expect(initializeScenarioStateAsync()).resolves.toBeUndefined();
        await expect(refreshScenarioStateAsync()).resolves.toBeUndefined();
        await expect(flushScenarioStateWrites()).resolves.toBeUndefined();
    });
});

describe('flushing the state and the resets asked for', () => {
    const flushOf = (flushes: Array<() => Promise<void>>) => {
        let flush!: typeof flushScenarioStateWrites;
        jest.isolateModules(() => {
            let next = 0;
            jest.doMock('../src/ts/settings/storage', () => ({
                createJsonStore: jest.fn(() => ({
                    readRaw: () => null,
                    writeRaw: jest.fn(),
                    initializeAsync: jest.fn(),
                    refreshAsync: jest.fn(),
                    flushPendingWrites: jest.fn(flushes[next++]),
                })),
            }));
            flush = (require('../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule)
                .flushScenarioStateWrites;
        });
        jest.dontMock('../src/ts/settings/storage');
        return flush;
    };
    const fails = (message: string) => async () => {
        throw new Error(message);
    };

    test('waits for the second store while the first one has already failed, and then says so', async () => {
        let finish!: () => void;
        const flush = flushOf([
            fails('store 0 not persisted'),
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        ]);
        let settled = false;
        const told = flush().finally(() => {
            settled = true;
        });
        told.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        finish();
        await expect(told).rejects.toThrow('store 0 not persisted');
    });

    test('says so when only the second store did not persist', async () => {
        const flush = flushOf([async () => {}, fails('store 1 not persisted')]);
        await expect(flush()).rejects.toThrow('store 1 not persisted');
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
        // Both are replaced whole, and a write the native bridge did not persist is a failed write.
        expect(createJsonStore).toHaveBeenCalledWith({
            fileName: 'scenarioState.json',
            prefKey: 'gs_scenario_state',
            atomic: true,
            strict: true,
        });
        expect(createJsonStore).toHaveBeenCalledWith({
            fileName: 'scenarioResets.json',
            prefKey: 'gs_scenario_resets',
            atomic: true,
            strict: true,
        });
        jest.dontMock('../src/ts/settings/storage');
    });
});
