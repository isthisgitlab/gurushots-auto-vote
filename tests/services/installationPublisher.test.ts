/**
 * The installation scenario's publication step (services/scenarioRunner/installation.ts), path by path over a stubbed
 * settings facade and a real in-memory ledger: who publishes, what stops it, and what each outcome writes. The facade's own
 * reads and the two runtimes over one storage are covered in tests/integration/scenarioSnapshotIsolation.test.ts.
 */

jest.mock('../../src/ts/core/logger', () => {
    const level = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn() };
    return { __esModule: true, withCategory: () => level, __level: level };
});
jest.mock('../../src/ts/core/settings', () => ({
    getInstallationScenario: jest.fn(),
    getScenario: jest.fn(),
    installationGeneration: jest.fn(),
    prepareInstallationSnapshot: jest.fn(),
    getSetting: jest.fn(() => 'UTC'),
    // The installation's own read of the time zone: the saved one while no installation scenario overlays it.
    captureInstallationSettings: jest.fn(() => ({ ok: true, values: { timezone: 'UTC' } })),
}));

import { createStateLedger, initialState } from '../../src/ts/core/scenarioStateStore';
import { createMemoryRawJsonStore } from '../../src/ts/core/parseUntrustedJson';
import { installTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';

import type * as installationModule from '../../src/ts/core/services/scenarioRunner/installation';
import type * as settingsModule from '../../src/ts/core/settings';
import type { InstallationPass } from '../../src/ts/core/services/scenarioRunner/installation';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { ScenarioPublication, ScenarioState } from '../../src/ts/core/types/stores';

const { publishInstallationOverlay } =
    require('../../src/ts/core/services/scenarioRunner/installation') as typeof installationModule;
const settings = jest.mocked(require('../../src/ts/core/settings') as typeof settingsModule);
type LevelFn = jest.Mock<void, [message: unknown, data?: unknown]>;
const level = (require('../../src/ts/core/logger') as { __level: Record<string, LevelFn> }).__level;

const KEY = '@installation';
const NOW = Math.floor(Date.now() / 1000);

const document = (over: Partial<ScenarioDocument> = {}): ScenarioDocument =>
    invalid<ScenarioDocument>({
        name: 'Account plan',
        version: 1,
        scope: 'installation',
        start: 'tune',
        phases: {
            tune: { settings: { apiTimeout: 12 } },
            // a phase with bindings, to have evidence to read
            watch: { bindings: { currencyReserveKeys: { kind: 'fact', name: 'balance.keys' } } },
        },
        ...over,
    });

const publication = (over: Partial<ScenarioPublication> = {}): ScenarioPublication => ({
    revision: 1,
    documentFingerprint: 'abc',
    phase: 'tune',
    phaseEnteredAt: NOW,
    observedAt: NOW,
    validUntil: null,
    bindings: {},
    profile: null,
    generation: 1,
    ...over,
});

let ledger: ReturnType<typeof createStateLedger>;
let store: ReturnType<typeof createMemoryRawJsonStore>;
const getBankroll = jest.fn(async () => ({ keys: 5, swaps: 0, fills: 0, coins: 0 }));

const pass = (over: Partial<InstallationPass> = {}): InstallationPass => ({
    token: 'tok',
    ledger,
    reads: { getBankroll },
    ...over,
});

const record = () => ledger.get(KEY).state as ScenarioState;

/** The record the selection of the plan leaves (progress.ts of the lifecycle): the start phase, at generation 1. */
const seed = (over: Partial<ScenarioState> = {}) =>
    ledger.change(KEY, () => ({ ...initialState('Account plan', 'tune', NOW), generation: 1, ...over }));

beforeEach(() => {
    jest.clearAllMocks();
    store = createMemoryRawJsonStore();
    ledger = createStateLedger(store);
    installTestPlatform();
    settings.getInstallationScenario.mockReturnValue({ scenario: 'Account plan', executor: 'electron', generation: 1 });
    settings.getScenario.mockReturnValue(document());
    settings.installationGeneration.mockReturnValue(1);
    settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: publication() });
});

describe('who publishes', () => {
    test('nothing is read or written for an installation with no scenario', async () => {
        settings.getInstallationScenario.mockReturnValue(null);
        const ledgerGet = jest.spyOn(ledger, 'get');
        await expect(publishInstallationOverlay(pass())).resolves.toBe('none');
        expect(ledgerGet).not.toHaveBeenCalled();
        expect(settings.getScenario).not.toHaveBeenCalled();
    });

    test('a runtime that is not the named executor reads nothing and writes nothing', async () => {
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Account plan', executor: 'cli', generation: 1 });
        const ledgerGet = jest.spyOn(ledger, 'get');
        await expect(publishInstallationOverlay(pass())).resolves.toBe('not-owner');
        expect(ledgerGet).not.toHaveBeenCalled();
        expect(getBankroll).not.toHaveBeenCalled();
    });

    test.each([
        ['a scenario that does not exist', null],
        ['a challenge scenario', document({ scope: 'challenge' })],
    ])('%s is not run', async (_name, found) => {
        settings.getScenario.mockReturnValue(found);
        await expect(publishInstallationOverlay(pass())).resolves.toBe('none');
        expect(ledger.get(KEY).state).toBeNull();
    });

    test('a progress record that cannot be read gives no generation to publish under', async () => {
        settings.installationGeneration.mockReturnValue(null);
        await expect(publishInstallationOverlay(pass())).resolves.toBe('unreadable');
    });

    test('a generation the assignment has not reached (a change begun and not finished) publishes nothing', async () => {
        settings.installationGeneration.mockReturnValue(2);
        await expect(publishInstallationOverlay(pass())).resolves.toBe('stale');
        expect(ledger.get(KEY).state).toBeNull();
    });
});

describe('the time zone of the cycle', () => {
    const zoneReads = () =>
        jest.mocked(settings.captureInstallationSettings).mock.calls.filter(([keys]) => keys.join() === 'timezone');

    test('is the installation’s effective one, captured once, after ownership', async () => {
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(zoneReads()).toHaveLength(1);
        // An installation with no scenario here (or one another runtime owns) reads no zone.
        jest.mocked(settings.captureInstallationSettings).mockClear();
        settings.getInstallationScenario.mockReturnValue(null);
        await publishInstallationOverlay(pass());
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Account plan', executor: 'cli', generation: 1 });
        await publishInstallationOverlay(pass());
        expect(zoneReads()).toHaveLength(0);
    });

    test('one that cannot be read publishes nothing: the saved zone never takes its place', async () => {
        jest.mocked(settings.captureInstallationSettings).mockReturnValueOnce({
            ok: false,
            key: 'timezone',
            reason: 'the published settings of this phase have expired',
        });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('unavailable');
        expect(settings.prepareInstallationSnapshot).not.toHaveBeenCalled();
        expect(ledger.get(KEY).state).toBeNull();
    });
});

describe('the step lock', () => {
    test('is taken for the installation, and released when the step ends', async () => {
        const release = jest.fn();
        const lock = jest.fn(() => ({ ok: true as const, release }));
        await expect(publishInstallationOverlay(pass({ lock }))).resolves.toBe('published');
        expect(lock).toHaveBeenCalledWith(KEY);
        expect(release).toHaveBeenCalledTimes(1);
    });

    test('a step another process holds is not waited for', async () => {
        const lock = jest.fn(() => ({ ok: false as const, release: jest.fn() }));
        await expect(publishInstallationOverlay(pass({ lock }))).resolves.toBe('busy');
        expect(ledger.get(KEY).state).toBeNull();
    });

    test('is released when the step throws, and the throw is logged, never raised', async () => {
        const release = jest.fn();
        settings.prepareInstallationSnapshot.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(publishInstallationOverlay(pass({ lock: () => ({ ok: true, release }) }))).resolves.toBe('failed');
        expect(release).toHaveBeenCalledTimes(1);
        expect(level.error).toHaveBeenCalledWith('installation settings could not be published: boom', null);
    });

    test('a throw with no message is still logged', async () => {
        settings.prepareInstallationSnapshot.mockImplementation(() => {
            throw 'plain';
        });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('failed');
        expect(level.error).toHaveBeenCalledWith('installation settings could not be published: plain', null);
    });
});

describe('what stops it under the lock', () => {
    test('a record that cannot be read', async () => {
        store.writeRaw('not json');
        await expect(publishInstallationOverlay(pass())).resolves.toBe('unreadable');
    });

    test.each([
        ['paused', { paused: { at: NOW, reason: 'test' } }],
        ['withdrawn by a full Stop', { withdrawn: { at: NOW, epoch: 1 } }],
        ['a handoff not finished', { handoff: { from: 'Account plan', to: null, generation: 1, at: NOW } }],
    ])('a subject %s publishes nothing and reads no evidence', async (_name, over) => {
        seed(over);
        await expect(publishInstallationOverlay(pass())).resolves.toBe('held');
        expect(settings.prepareInstallationSnapshot).not.toHaveBeenCalled();
    });

    test("a record that is another scenario's is not published over", async () => {
        seed({ scenario: 'Other plan' });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('stale');
        expect(record().scenario).toBe('Other plan');
        expect(record().published).toBeUndefined();
    });

    test('a phase the scenario no longer has publishes nothing', async () => {
        seed({ phase: 'gone' });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('none');
    });
});

describe('what it writes', () => {
    test('with no record yet it starts the scenario at its start phase, at the assigned generation, with the publication', async () => {
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(record()).toMatchObject({
            scenario: 'Account plan',
            phase: 'tune',
            generation: 1,
            published: { revision: 1, generation: 1 },
        });
        expect(settings.prepareInstallationSnapshot).toHaveBeenCalledWith(
            expect.anything(),
            { phase: 'tune', phaseEnteredAt: expect.any(Number), published: undefined },
            expect.any(Function),
            1,
            expect.any(Number),
        );
    });

    test('the next publication is made over the record as it is, keeping its progress', async () => {
        seed({ memory: { slot: 'photo' }, spent: { swaps: 2, keys: 0, fills: 0 }, published: publication() });
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: publication({ revision: 2 }) });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(record()).toMatchObject({
            memory: { slot: 'photo' },
            spent: { swaps: 2, keys: 0, fills: 0 },
            published: { revision: 2 },
        });
    });

    test('a phase that sets nothing withdraws the publication of an earlier one', async () => {
        seed({ published: publication() });
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: null });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('cleared');
        expect(record().published).toBeUndefined();
    });

    test('a phase that cannot be prepared clears the publication, records the halt once as a notice, and says so', async () => {
        seed({ published: publication() });
        settings.prepareInstallationSnapshot.mockReturnValue({
            ok: false,
            key: 'currencyReserveKeys',
            reason: 'out of range',
        });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('blocked');
        await expect(publishInstallationOverlay(pass())).resolves.toBe('blocked');
        expect(record().published).toBeUndefined();
        expect(record().lastError?.message).toBe('phase tune: currencyReserveKeys: out of range');
        expect(record().outbox).toHaveLength(1);
        expect(level.error).toHaveBeenCalledWith(
            'installation scenario halted: phase tune: currencyReserveKeys: out of range',
            null,
        );
    });

    test('a phase halted for no one key (a profile) is worded without a key', async () => {
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: false, key: null, reason: 'unusable' });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('blocked');
        expect(record().lastError?.message).toBe('phase tune: unusable');
    });

    test('a record written without a generation is brought to the assigned one (generation 0)', async () => {
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 0,
        });
        settings.installationGeneration.mockReturnValue(0);
        ledger.change(KEY, () => initialState('Account plan', 'tune', NOW));
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: publication({ generation: 0 }) });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(record().generation).toBe(0);
    });
});

describe('the bindings are worked out from the account evidence under the saved policy', () => {
    test('the balance is read once for a phase that binds it, and the bindings see it', async () => {
        seed({ phase: 'watch' });
        settings.prepareInstallationSnapshot.mockImplementation((_scenario, _at, resolveBindings) => {
            const { bound } = resolveBindings(() => invalid({ state: 'unknown' }));
            expect(bound.currencyReserveKeys).toEqual({
                state: 'known',
                value: { kind: 'number', value: 5, quantity: 'keys' },
            });
            return { ok: true, publication: publication({ phase: 'watch' }) };
        });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(getBankroll).toHaveBeenCalledTimes(1);
        expect(getBankroll).toHaveBeenCalledWith('tok', expect.objectContaining({ timeoutSec: expect.anything() }));
    });

    test('a phase with no bindings reads no evidence', async () => {
        await publishInstallationOverlay(pass());
        expect(getBankroll).not.toHaveBeenCalled();
    });

    test("a bound phase with no expressions at all still prepares (the callback is the facade's)", async () => {
        seed({ phase: 'watch' });
        settings.prepareInstallationSnapshot.mockImplementation((scenario, _at, resolveBindings) => {
            const resolved = resolveBindings(() => invalid({ state: 'unknown' }));
            expect(resolved.validUntil).toBeNull();
            expect(scenario.phases.watch.bindings).toBeDefined();
            return { ok: true, publication: publication() };
        });
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
    });
});

describe('the generation fence of the write', () => {
    const holdEvidence = () => {
        let release!: () => void;
        const held = new Promise<void>((done) => {
            release = done;
        });
        getBankroll.mockImplementationOnce(async () => {
            await held;
            return { keys: 5, swaps: 0, fills: 0, coins: 0 };
        });
        return release;
    };

    test('a record that moved to another generation while the evidence was read refuses the write', async () => {
        seed({ phase: 'watch' });
        const release = holdEvidence();
        const running = publishInstallationOverlay(pass());
        await new Promise<void>((done) => setImmediate(done));
        ledger.change(KEY, (current) => ({ ...(current as ScenarioState), generation: 2 }));
        release();
        await expect(running).resolves.toBe('stale');
        expect(record().published).toBeUndefined();
        expect(record().generation).toBe(2);
    });

    test('a record whose phase entry changed meanwhile refuses the write', async () => {
        seed({ phase: 'watch' });
        const release = holdEvidence();
        const running = publishInstallationOverlay(pass());
        await new Promise<void>((done) => setImmediate(done));
        ledger.change(KEY, (current) => ({ ...(current as ScenarioState), phaseEnteredAt: NOW + 50 }));
        release();
        await expect(running).resolves.toBe('stale');
    });

    test('a pause that landed meanwhile refuses the write', async () => {
        seed({ phase: 'watch' });
        const release = holdEvidence();
        const running = publishInstallationOverlay(pass());
        await new Promise<void>((done) => setImmediate(done));
        ledger.change(KEY, (current) => ({ ...(current as ScenarioState), paused: { at: NOW, reason: 'test' } }));
        release();
        await expect(running).resolves.toBe('held');
        expect(record().published).toBeUndefined();
    });

    test('a write the ledger could not make is a failure, said so', async () => {
        const failing = { ...ledger, change: () => ({ ok: false as const, reason: 'not-saved' }) };
        await expect(
            publishInstallationOverlay(pass({ ledger: invalid<InstallationPass['ledger']>(failing) })),
        ).resolves.toBe('failed');
        expect(level.warning).toHaveBeenCalledWith('installation settings were not saved (not-saved)', null);
    });
});
