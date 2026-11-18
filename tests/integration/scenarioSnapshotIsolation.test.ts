/**
 * The settings a scenario phase publishes, end to end over the REAL settings, ledger, runner step and voting pass:
 *   - an awaited pass keeps reading the overlay it published while a private preview with other evidence is built and
 *     disposed (a preview never publishes, replaces or clears it);
 *   - a second settings runtime over the same storage reads the owner's publication and never publishes;
 *   - a phase whose bindings cannot be resolved exposes no inherited value: the getter throws, the typed read is
 *     unknown, and the voting pass skips that challenge without abandoning the others.
 * The Android WebView store adapters are the headless transport the helpers install (the same store the service writes).
 *
 * The installation scenario's publication is covered at the end: only the owner executor publishes, a former owner's write
 * is refused, another runtime reads the owner's publication, a withdrawal or an expiry reads as it must, the saved
 * configuration is never rewritten, and the transport of an actual request runs under the published policy.
 */

const mockLogs: Array<{ level: string; msg: string }> = [];

jest.mock('../../src/ts/core/logger', () => {
    const category = new Proxy(
        {},
        {
            get:
                (_target, level: string) =>
                (msg: unknown, ...rest: unknown[]) => {
                    mockLogs.push({ level, msg: String(msg) + (typeof rest[0] === 'string' ? ` ${rest[0]}` : '') });
                },
        },
    );
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown; title?: unknown } | null | undefined) =>
            `[Challenge ${challenge?.id}: ${challenge?.title}]`,
    };
    // Anything else the pass reaches for on the logger is a no-op.
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { installHeadlessTestPlatform } from '../helpers/platform';
import { createHeadlessPlatform } from '../../src/ts/platforms/headless';
import axiosModule = require('axios');
import { invalid } from '../helpers/invalid';
import { parseJsonAs, parseJsonObject } from '../helpers/parseJson';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { buildChallenge } from '../helpers/challengeFixtures';
import settings = require('../../src/ts/core/settings');
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as votingOrchestratorModule from '../../src/ts/core/services/votingOrchestrator';
import type * as expressionsModule from '../../src/ts/core/scenarios/expressions';
import type * as installationModule from '../../src/ts/core/services/scenarioRunner/installation';
import type * as joinApiModule from '../../src/ts/core/api/join';
import type { AxiosRequestConfig } from 'axios';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { VotingPassDeps } from '../../src/ts/core/types/votingPass';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';

const { scenarioStateLedger, refreshScenarioStateAsync } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { runVotingPass } = require('../../src/ts/core/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { known } = require('../../src/ts/core/scenarios/expressions') as typeof expressionsModule;
const { publishInstallationOverlay } =
    require('../../src/ts/core/services/scenarioRunner/installation') as typeof installationModule;
const { getBankroll } = require('../../src/ts/core/api/join') as typeof joinApiModule;
// tests/setup.ts replaces axios with a bare jest.fn(), called with one config.
const axios: jest.Mock<Promise<unknown>, [config: AxiosRequestConfig]> = invalid(axiosModule);

const NOW = Math.floor(Date.now() / 1000);
const OWNED = 7;
const SIBLING = 8;

const percent = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'percent' });
const plus = (key: string, amount: number) =>
    invalid<ScenarioExpr>({
        kind: 'add',
        left: { kind: 'setting', key, view: 'base' },
        right: percent(amount),
    });

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

/** Lets the pass run until `condition` holds (it stops at the held read). */
const until = async (condition: () => boolean) => {
    for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise<void>((done) => setImmediate(done));
    expect(condition()).toBe(true);
};

const quiet = (id: number, title: string): Challenge =>
    buildChallenge({
        id,
        title,
        type: 'regular',
        start_time: NOW - 3600,
        close_time: NOW + 5 * 86400,
        max_photo_submits: 4,
        member: {
            ranking: {
                entries: [{ id: `e-${id}`, member_id: 'm', votes: 5 }],
                exposure: { exposure_factor: 100 },
                swaps: [],
            },
        },
    });

/**
 * A plan whose bound phase tells once, then looks again (a rule that reads the missions): the second look awaits the
 * evidence read the test holds, with the first publication standing.
 */
const plan = (
    bindings: Record<string, ScenarioExpr> = { exposure: plus('exposure', 20) },
    literals: Record<string, unknown> = { exposureTarget: 90 },
) => ({
    name: 'Plan',
    version: 1,
    start: 'push',
    phases: {
        push: {
            settings: literals,
            bindings,
            rules: [
                { id: 'tell', repeat: 'once', do: [{ type: 'notify', message: 'started' }] },
                {
                    id: 'watch',
                    if: [
                        {
                            type: 'compare',
                            left: { kind: 'fact', name: 'missions.joinNeed' },
                            op: '>',
                            right: { kind: 'literal', value: 0, quantity: 'count' },
                        },
                    ],
                    do: [{ type: 'notify', message: 'missions' }],
                },
            ],
        },
    },
});

const state = () => scenarioStateLedger.get(OWNED).state as ScenarioState;
const rawLedger = (store: MemoryStore) => store.keys.get('gs_scenario_state');

/** A pass over `challenges`, with the missions read answered by `getMyMissions`. */
const passDeps = (
    challenges: Challenge[],
    getMyMissions: jest.Mock<Promise<unknown[]>, []> = jest.fn(async () => []),
): VotingPassDeps =>
    invalid<VotingPassDeps>({
        api: new Proxy(
            {
                getActiveChallenges: async () => ({ challenges }),
                getMyMissions,
                getVoteImages: async () => [],
            },
            {
                get: (target, key: string) =>
                    key in target ? target[key as keyof typeof target] : jest.fn(async () => null),
            },
        ),
        interChallengeDelay: async () => {},
        cleanupStaleMetadata: null,
        entryTracker: null,
        entryAges: null,
        currency: {
            strategy: { getBankroll: async () => null },
            swapLedger: null,
            spendLedger: null,
        },
        scenarios: { ledger: scenarioStateLedger },
    });

describe('published scenario settings', () => {
    let store: MemoryStore;

    beforeEach(async () => {
        mockLogs.length = 0;
        store = installHeadlessStore();
        // the ledger's cache outlives the store: start every test from no progress
        await scenarioStateLedger.removeAll();
        settings.setGlobalDefault('exposure', 30);
        settings.setGlobalDefault('exposureTarget', 100);
        settings.setChallengeOverride('exposure', String(OWNED), 40);
        settings.rememberChallengeTitles([
            { id: OWNED, title: 'Owned', type: 'regular' },
            { id: SIBLING, title: 'Sibling', type: 'regular' },
        ]);
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    const assign = (doc: unknown = plan()) => {
        // A replacement states the revision of the collection it was edited on.
        expect(
            settings.saveScenario(doc, {
                expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
            }),
        ).toEqual({ ok: true, name: 'Plan' });
        settings.setChallengeOverride('scenario', String(OWNED), 'Plan');
    };

    test('a pass publishes the overlay of its phase, and every route reads it', async () => {
        assign();
        const result = await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(result.success).toBe(true);
        expect(state().published).toMatchObject({ revision: 2, phase: 'push', bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(settings.getEffectiveSetting('exposureTarget', OWNED)).toBe(90);
        // the base view, and the stored override, are untouched
        expect(settings.readScenarioSetting('exposure', 'base', OWNED)).toMatchObject({ value: { value: 40 } });
        expect(settings.getChallengeOverrides(String(OWNED))).toMatchObject({ exposure: 40 });
    });

    test('an awaited pass keeps its own publication while a private preview with other evidence is built and disposed', async () => {
        assign();
        const release = deferred<unknown[]>();
        // the first look is quick; the second (after the rule fired) is held
        const getMyMissions = jest
            .fn<Promise<unknown[]>, []>()
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => release.promise);
        const pass = runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')], getMyMissions));
        await until(() => getMyMissions.mock.calls.length === 2);

        // the pass is mid-step: its first publication stands, and it is what a read gives
        const during = scenarioStateLedger.get(OWNED).state?.published;
        expect(during).toMatchObject({ revision: 1, bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        const before = rawLedger(store);

        // a private preview with different evidence: it prepares its own snapshot and drops it
        const scenario = settings.getScenario('Plan') as ScenarioDocument;
        const preview = settings.prepareScenarioSnapshot(
            OWNED,
            scenario,
            state(),
            () => ({
                bound: { exposure: known({ kind: 'number', value: 77, quantity: 'percent' }) },
                validUntil: null,
            }),
            NOW,
        );
        expect(preview).toMatchObject({ ok: true });
        if (!preview.ok) throw new Error('prepared');
        expect(preview.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 77 } });
        expect(preview.snapshot.publication).toMatchObject({ revision: 2, bindings: { exposure: 77 } });
        // a status read, and the typed read, are private as well
        expect(settings.scenarioOverlayStatus(OWNED)).toMatchObject({
            available: true,
            published: { revision: 1 },
        });
        expect(settings.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ value: { value: 60 } });

        // disposed: nothing written, replaced or cleared, and the pass still reads what it published
        expect(rawLedger(store)).toBe(before);
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(scenarioStateLedger.get(OWNED).state?.published).toEqual(during);

        release.resolve([]);
        await expect(pass).resolves.toMatchObject({ success: true });
        // only the owner republished, from its own evidence
        expect(state().published).toMatchObject({ revision: 2, bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
    });

    test('a second settings runtime over the same storage reads the publication and never publishes', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        const before = rawLedger(store);
        expect(before).toContain('"published"');

        let other!: typeof settings;
        let otherLedger!: typeof scenarioStateLedger;
        jest.isolateModules(() => {
            installHeadlessTestPlatform();
            other = require('../../src/ts/core/settings') as typeof settings;
            otherLedger = (require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule)
                .scenarioStateLedger;
        });
        // a runtime of its own: modules, caches and platform are not the first one's
        expect(other).not.toBe(settings);
        expect(otherLedger).not.toBe(scenarioStateLedger);

        expect(other.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(other.getEffectiveSetting('exposureTarget', OWNED)).toBe(90);
        expect(other.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(other.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ value: { value: 60 } });
        // it may prepare a private snapshot, and drop it
        const scenario = other.getScenario('Plan') as ScenarioDocument;
        const prepared = other.prepareScenarioSnapshot(
            OWNED,
            scenario,
            otherLedger.get(OWNED).state as ScenarioState,
            () => ({
                bound: { exposure: known({ kind: 'number', value: 55, quantity: 'percent' }) },
                validUntil: null,
            }),
            NOW,
        );
        expect(prepared).toMatchObject({ ok: true });
        // nothing it did wrote the shared ledger
        expect(rawLedger(store)).toBe(before);
        expect(scenarioStateLedger.get(OWNED).state?.published).toMatchObject({ bindings: { exposure: 60 } });
    });

    const exposureIs = (value: number) => ({
        type: 'compare',
        left: { kind: 'setting', key: 'exposure', view: 'effective' },
        op: '=',
        right: { kind: 'literal', value, quantity: 'percent' },
    });

    test('a phase change republishes before the next phase evaluates, in the same pass', async () => {
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: {
                push: {
                    settings: { exposureTarget: 90 },
                    bindings: { exposure: plus('exposure', 20) },
                    rules: [{ id: 'go', repeat: 'once', do: [{ type: 'goto', phase: 'next' }] }],
                },
                next: {
                    settings: { exposureTarget: 95 },
                    bindings: { exposure: plus('exposure', 30) },
                    // its condition reads the effective exposure: only the new phase's overlay makes it 70
                    rules: [
                        { id: 'seen', repeat: 'once', if: [exposureIs(70)], do: [{ type: 'notify', message: 'x' }] },
                    ],
                },
            },
        });
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(Object.keys(state().fired).sort()).toEqual(['go', 'seen']);
        expect(state().phase).toBe('next');
        // published for the first phase, for the second, and once more after its rule landed
        expect(state().published).toMatchObject({ revision: 3, phase: 'next', bindings: { exposure: 70 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(70);
        expect(settings.getEffectiveSetting('exposureTarget', OWNED)).toBe(95);
    });

    test('leaving a bound phase for one with literals only clears the publication; its rules read the effective values', async () => {
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: {
                push: {
                    bindings: { exposure: plus('exposure', 20) },
                    settings: { exposureTarget: 90 },
                    rules: [{ id: 'go', repeat: 'once', do: [{ type: 'goto', phase: 'plain' }] }],
                },
                plain: {
                    settings: { exposure: 10, exposureTarget: 12 },
                    rules: [
                        { id: 'seen', repeat: 'once', if: [exposureIs(10)], do: [{ type: 'notify', message: 'x' }] },
                    ],
                },
            },
        });
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().fired.seen).toBeDefined();
        expect(state().published).toBeUndefined();
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(10);
    });

    test('a conflict between the resolved values blocks the phase', async () => {
        // exposure 40 + 70 = 110% is not a percentage
        assign(plan({ exposure: plus('exposure', 70) }));
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published).toBeUndefined();
        expect(state().lastError?.message).toContain('exposure');
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
    });

    test('the publication is valid until the next instant its bindings stand for', async () => {
        const unit = (value: number, name: string) => ({ kind: 'literal', value, quantity: 'duration', unit: name });
        const hours = (value: number) => unit(value, 'hours');
        const seconds = (value: number) => unit(value, 'seconds');
        const end = { kind: 'fact', name: 'challenge.end' };
        const beforeEnd = (by: number) => ({ kind: 'offset', from: end, by: hours(by), direction: 'before' });
        const expressions: Record<string, unknown> = {
            // two hours between "two hours before the end" and the end
            boostTime: { kind: 'difference', from: beforeEnd(2), to: end },
            // the smaller of two waits, the larger of two thresholds, a difference of durations
            boostFreshEntryWait: { kind: 'min', of: [seconds(60), seconds(30)] },
            lastMinuteThreshold: { kind: 'max', of: [unit(5, 'minutes'), unit(7, 'minutes')] },
            turboTime: { kind: 'subtract', left: seconds(100), right: seconds(40) },
            // one hour between the earlier and the later of two instants
            keyUnlockedBoostTime: {
                kind: 'difference',
                from: { kind: 'earlier', of: [end, beforeEnd(1)] },
                to: { kind: 'later', of: [end, beforeEnd(1)] },
            },
        };
        assign(plan(invalid<Record<string, ScenarioExpr>>(expressions), {}));
        const owned = quiet(OWNED, 'Owned');
        await runVotingPass('tok', null, passDeps([owned]));
        expect(state().published).toMatchObject({
            validUntil: owned.close_time - 7200,
            bindings: {
                boostTime: 7200,
                boostFreshEntryWait: 30,
                lastMinuteThreshold: 7,
                turboTime: 60,
                keyUnlockedBoostTime: 3600,
            },
        });
        expect(settings.getEffectiveSetting('boostTime', OWNED)).toBe(7200);
        expect(settings.getEffectiveSetting('lastMinuteThreshold', OWNED)).toBe(7);
    });

    /** The real ledger, but a write the test names fails (as a held lock or a full disk would make it). */
    const failingLedger = (fails: (written: ScenarioState) => boolean) => ({
        ...scenarioStateLedger,
        set: (id: string | number, written: ScenarioState) =>
            fails(written) ? ('failed' as const) : scenarioStateLedger.set(id, written),
    });

    const passWith = (ledger: ReturnType<typeof failingLedger>) => {
        const deps = passDeps([quiet(OWNED, 'Owned')]);
        return runVotingPass('tok', null, { ...deps, scenarios: { ledger } });
    };

    test('a publication that could not be saved leaves no rule run and the challenge unavailable', async () => {
        assign();
        await expect(passWith(failingLedger((written) => written.published !== undefined))).resolves.toMatchObject({
            success: true,
        });
        expect(state().published).toBeUndefined();
        expect(state().fired).toEqual({});
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
    });

    test('a stale publication that could not be cleared is still never read: the document changed', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        const stale = state().published;
        assign(blockedPlan({ profile: 'Missing' }));
        // only the write that clears it fails
        await passWith(failingLedger((written) => written.published === undefined));
        expect(state().published).toEqual(stale);
        expect(state().lastError).toBeNull();
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(() => settings.getEffectiveSetting('exposure', OWNED)).toThrow(settings.ScenarioSettingUnavailableError);
    });

    test('bindings that stand for no future instant never expire', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published?.validUntil).toBeNull();
    });

    /** The phase's bindings and profile are the whole difference between the blocked plans below. */
    const blockedPlan = (phase: Record<string, unknown>) => ({
        name: 'Plan',
        version: 1,
        start: 'push',
        phases: { push: { rules: [{ id: 'tell', do: [{ type: 'notify', message: 'never' }] }], ...phase } },
    });

    const expectBlocked = async (reason: string) => {
        const challenges = [quiet(OWNED, 'Owned'), quiet(SIBLING, 'Sibling')];
        const result = await runVotingPass('tok', null, passDeps(challenges));
        expect(result.success).toBe(true);

        // nothing is published, the reason is recorded, no rule ran
        expect(state().published).toBeUndefined();
        expect(state().lastError?.message).toContain(reason);
        expect(state().outbox?.some((notice) => notice.message.includes(reason))).toBe(true);

        // no inherited value anywhere: the getter throws, the typed read is unknown, the status says why
        expect(() => settings.getEffectiveSetting('exposure', OWNED)).toThrow(settings.ScenarioSettingUnavailableError);
        expect(settings.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ state: 'unknown' });
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(settings.scenarioOverlayStatus(OWNED)).toMatchObject({ bound: true, available: false });

        // the pass skipped that challenge, said so, and went on to the next
        expect(mockLogs.some((line) => line.msg.includes('Owned') && line.msg.includes('settings unavailable'))).toBe(
            true,
        );
        expect(mockLogs.some((line) => line.msg.includes('Processing challenge 2/2: Sibling'))).toBe(true);
        expect(mockLogs.some((line) => line.msg.includes('Skipped after an unexpected error'))).toBe(false);
    };

    test('a binding that cannot be resolved exposes no inherited value, and the pass skips only that challenge', async () => {
        // the balance cannot be read, so the swap cap bound to it is unknown
        assign(blockedPlan({ bindings: { autoSwapMax: { kind: 'fact', name: 'balance.swaps' } } }));
        await expectBlocked('autoSwapMax');
        // no rule ran for the blocked phase
        expect(state().fired).toEqual({});
    });

    test('a stale publication is cleared when the phase can no longer be prepared', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published).toBeDefined();
        // the plan is edited so that its phase names a profile that does not exist
        assign(blockedPlan({ profile: 'Missing' }));
        await expectBlocked('profile-unavailable: Missing');
    });

    test('once the cause is gone the next pass publishes again and the challenge is back', async () => {
        assign(blockedPlan({ profile: 'Tactic' }));
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(settings.saveChallengeProfile('Tactic', { boostTime: 120 })).toBe(true);
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(settings.getEffectiveSetting('boostTime', OWNED)).toBe(120);
        expect(state().published).toMatchObject({ profile: 'Tactic' });
    });
});

describe('the installation scenario publication', () => {
    const INSTALLATION = '@installation';
    let store: MemoryStore;

    const keysOf = (count: number) => ({ keys: count, swaps: 0, fills: 0, coins: 0 });
    const bankrollOf = (count: number) => async () => keysOf(count);
    const ownerReads = (count = 7) => ({ getBankroll: bankrollOf(count) });

    /** One phase: a literal API timeout, and a reserve bound to the balance of keys. */
    const accountPlan = (phase: Record<string, unknown> = {}) => ({
        name: 'Account plan',
        version: 1,
        scope: 'installation',
        start: 'tune',
        phases: {
            tune: {
                settings: { apiTimeout: 12 },
                bindings: { currencyReserveKeys: { kind: 'fact', name: 'balance.keys' } },
                ...phase,
            },
        },
    });

    const save = (doc: unknown = accountPlan()) =>
        expect(
            settings.saveScenario(doc, {
                expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
            }),
        ).toEqual({ ok: true, name: 'Account plan' });

    /** Selects the plan for `executor` (the runtime these tests run as is the Android service). */
    const select = (
        executor: 'android-service' | 'electron' | 'cli' = 'android-service',
        doc: unknown = accountPlan(),
    ) => {
        save(doc);
        expect(settings.setInstallationScenario('Account plan', executor, 0)).toMatchObject({
            ok: true,
            generation: 1,
        });
    };

    const record = () => scenarioStateLedger.get(INSTALLATION).state as ScenarioState;
    const publishAs = (count = 7) =>
        publishInstallationOverlay({ token: 'tok', ledger: scenarioStateLedger, reads: ownerReads(count) });

    beforeEach(async () => {
        mockLogs.length = 0;
        store = installHeadlessStore();
        actAs('android-service');
        await scenarioStateLedger.removeAll();
        axios.mockReset();
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    /** The platform of the runtime that acts next: the port is one slot, whichever runtime's modules read it. */
    const actAs = (executor: 'android-service' | 'electron') =>
        installHeadlessTestPlatform({
            capabilities: {
                ...createHeadlessPlatform({ broadcastSettingsChanged: () => undefined, afterWipe: () => undefined })
                    .capabilities,
                executor,
            },
        });

    /** A settings runtime of its own over the same storage (its modules, caches and ledger), for the electron executor. */
    const electronRuntime = () => {
        let runtime!: {
            settings: typeof settings;
            publish: typeof publishInstallationOverlay;
            ledger: typeof scenarioStateLedger;
        };
        jest.isolateModules(() => {
            actAs('electron');
            runtime = {
                settings: require('../../src/ts/core/settings') as typeof settings,
                publish: (
                    require('../../src/ts/core/services/scenarioRunner/installation') as typeof installationModule
                ).publishInstallationOverlay,
                ledger: (require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule)
                    .scenarioStateLedger,
            };
        });
        return runtime;
    };

    test('with no installation scenario every read is the saved value, and no progress record is read', async () => {
        const reads = jest.spyOn(scenarioStateLedger, 'get');
        expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        expect(settings.getEffectiveSetting('currencyReserveKeys')).toBe(0);
        expect(settings.captureInstallationSettings(['apiTimeout', 'apiMaxRetries'])).toEqual({
            ok: true,
            values: { apiTimeout: 30, apiMaxRetries: 3 },
        });
        expect(settings.readInstallationSetting('apiTimeout')).toMatchObject({ state: 'known' });
        await expect(publishAs()).resolves.toBe('none');
        expect(reads).not.toHaveBeenCalled();
        reads.mockRestore();
    });

    test('only the owner publishes: another runtime reads the publication and never writes it; the saved configuration is never rewritten', async () => {
        select('android-service');
        const config = store.value;
        await expect(publishAs(7)).resolves.toBe('published');

        expect(record().published).toMatchObject({
            generation: 1,
            phase: 'tune',
            revision: 1,
            bindings: { currencyReserveKeys: 7 },
        });
        // the published phase is what an installation consumer reads; the saved value is still the saved value
        expect(settings.getInstallationSetting('apiTimeout')).toBe(12);
        expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(7);
        expect(settings.getEffectiveSetting('currencyReserveKeys')).toBe(7);
        expect(settings.getSetting('apiTimeout')).toBe(30);
        expect(settings.getGlobalDefault('currencyReserveKeys')).toBe(0);
        // a setting the phase does not set is the saved one
        expect(settings.getInstallationSetting('apiMaxRetries')).toBe(3);
        expect(store.value).toBe(config);

        const owned = store.keys.get('gs_scenario_state');
        const other = electronRuntime();
        actAs('electron');
        expect(other.settings.getInstallationSetting('apiTimeout')).toBe(12);
        expect(other.settings.getInstallationSetting('currencyReserveKeys')).toBe(7);
        expect(other.settings.readInstallationSetting('currencyReserveKeys')).toMatchObject({
            state: 'known',
            value: { value: 7 },
        });
        // not its assignment's executor: it neither evaluates nor writes
        const askedFor = jest.fn(bankrollOf(1));
        await expect(
            other.publish({ token: 'tok', ledger: other.ledger, reads: { getBankroll: askedFor } }),
        ).resolves.toBe('not-owner');
        expect(askedFor).not.toHaveBeenCalled();
        expect(store.keys.get('gs_scenario_state')).toBe(owned);
        expect(store.value).toBe(config);
    });

    test('a former owner whose generation moved while it was reading fails its write and stops', async () => {
        select('android-service');
        const release = deferred<ReturnType<typeof keysOf>>();
        const reading = jest.fn(() => release.promise);
        // no step lock in this pass: the generation fence of the write is what stops it
        const pass = publishInstallationOverlay({
            token: 'tok',
            ledger: scenarioStateLedger,
            reads: { getBankroll: reading },
        });
        await until(() => reading.mock.calls.length === 1);
        // the owner hands the installation to the electron executor: generation 2
        expect(settings.transferInstallationOwner('electron', 1)).toMatchObject({ ok: true, generation: 2 });
        release.resolve(keysOf(7));

        await expect(pass).resolves.toBe('stale');
        expect(record().published).toBeUndefined();
        expect(record().generation).toBe(2);

        // the new owner publishes under generation 2; the former one now finds itself not the owner
        const next = electronRuntime();
        actAs('electron');
        await expect(next.publish({ token: 'tok', ledger: next.ledger, reads: ownerReads(9) })).resolves.toBe(
            'published',
        );
        expect(record().published).toMatchObject({ generation: 2, bindings: { currencyReserveKeys: 9 } });
        actAs('android-service');
        await expect(publishAs(1)).resolves.toBe('not-owner');
        expect(record().published).toMatchObject({ bindings: { currencyReserveKeys: 9 } });
    });

    test('a publication of an earlier owner generation is unavailable until the new owner publishes', async () => {
        select('android-service');
        await publishAs(7);
        expect(settings.getInstallationSetting('apiTimeout')).toBe(12);
        expect(settings.transferInstallationOwner('electron', 1)).toMatchObject({ ok: true, generation: 2 });
        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
        expect(settings.readInstallationSetting('apiTimeout')).toMatchObject({
            state: 'unknown',
            reason: expect.stringContaining('another owner'),
        });
        expect(settings.captureInstallationSettings(['apiMaxRetries', 'apiTimeout'])).toMatchObject({
            ok: false,
            key: 'apiTimeout',
        });
        // a key the phase does not set is not waiting for anyone
        expect(settings.getInstallationSetting('apiMaxRetries')).toBe(3);
    });

    test('a pause or a cleared assignment gives the saved values at once, with nothing written to the configuration', async () => {
        select('android-service');
        await publishAs(7);
        const config = store.value;
        expect(settings.getInstallationSetting('apiTimeout')).toBe(12);

        expect(
            scenarioStateLedger.change(INSTALLATION, (current) => ({
                ...(current as ScenarioState),
                paused: { at: NOW, reason: 'test' },
            })),
        ).toMatchObject({ ok: true });
        expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(0);
        expect(settings.getEffectiveSetting('currencyReserveKeys')).toBe(0);
        // the paused installation publishes nothing
        await expect(publishAs(9)).resolves.toBe('held');

        expect(
            scenarioStateLedger.change(INSTALLATION, (current) => ({ ...(current as ScenarioState), paused: null })),
        ).toMatchObject({ ok: true });
        expect(settings.getInstallationSetting('apiTimeout')).toBe(12);

        expect(settings.setInstallationScenario(null, 'android-service', 1)).toMatchObject({ ok: true });
        expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(0);
        // only the assignment changed: no installation value was ever written into the settings
        expect(JSON.parse(store.value as string)).toMatchObject({ app: { apiTimeout: 30 }, defaults: {} });
        expect(config).not.toContain('"installationScenario": undefined');
    });

    test('an expired publication is unavailable, never the saved value', async () => {
        select('android-service');
        await publishAs(7);
        expect(
            scenarioStateLedger.change(INSTALLATION, (current) => {
                const held = current as ScenarioState;
                return {
                    ...held,
                    published: { ...(held.published as NonNullable<ScenarioState['published']>), validUntil: NOW - 1 },
                };
            }),
        ).toMatchObject({ ok: true });

        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
        expect(() => settings.getEffectiveSetting('currencyReserveKeys')).toThrow(
            settings.ScenarioSettingUnavailableError,
        );
        expect(settings.readInstallationSetting('apiTimeout')).toMatchObject({
            state: 'unknown',
            reason: expect.stringContaining('expired'),
        });
        expect(settings.captureInstallationSettings(['apiTimeout'])).toMatchObject({ ok: false, key: 'apiTimeout' });
    });

    test('an edit of the scenario makes the publication unavailable until the owner publishes again', async () => {
        select('android-service');
        await publishAs(7);
        save(accountPlan({ settings: { apiTimeout: 15 } }));
        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
        await expect(publishAs(7)).resolves.toBe('published');
        expect(settings.getInstallationSetting('apiTimeout')).toBe(15);
    });

    test('a phase that cannot be prepared clears the publication, records why, and leaves its keys unavailable', async () => {
        select('android-service');
        await publishAs(7);
        // 2000 keys is over the reserve a setting may hold
        await expect(publishAs(2000)).resolves.toBe('blocked');
        expect(record().published).toBeUndefined();
        expect(record().lastError?.message).toContain('currencyReserveKeys');
        expect(record().outbox?.some((notice) => notice.message.includes('currencyReserveKeys'))).toBe(true);
        expect(() => settings.getInstallationSetting('currencyReserveKeys')).toThrow(
            settings.ScenarioSettingUnavailableError,
        );
        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
        // the same cause is recorded once
        await publishAs(2000);
        expect(record().outbox?.filter((notice) => notice.message.includes('currencyReserveKeys'))).toHaveLength(1);
        // once it is gone the next publication stands
        await expect(publishAs(5)).resolves.toBe('published');
        expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(5);
    });

    test('an app setting out of its range is refused, however the document spelled it', async () => {
        select('android-service', accountPlan({ settings: { apiTimeout: 9999 }, bindings: {} }));
        await expect(publishAs()).resolves.toBe('blocked');
        expect(record().lastError?.message).toBe('phase tune: apiTimeout: apiTimeout is out of range');
        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
    });

    test('values that are valid alone but not together are refused as a whole', async () => {
        select('android-service', accountPlan({ settings: { checkFrequencyMax: 2 }, bindings: {} }));
        // the saved minimum (3) is above the phase's maximum (2)
        await expect(publishAs()).resolves.toBe('blocked');
        expect(record().lastError?.message).toContain('checkFrequencyMin and checkFrequencyMax');
        expect(() => settings.getInstallationSetting('checkFrequencyMax')).toThrow(
            settings.ScenarioSettingUnavailableError,
        );
    });

    test('a phase that sets nothing publishes nothing and withdraws what an earlier phase published', async () => {
        select('android-service');
        await publishAs(7);
        save(accountPlan({ settings: {}, bindings: {} }));
        await expect(publishAs(7)).resolves.toBe('cleared');
        expect(record().published).toBeUndefined();
        expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
    });

    test('a request runs under the published transport policy while the saved settings stay as they are', async () => {
        select('android-service');
        axios.mockResolvedValue({ status: 200, headers: {}, data: { success: true, bankroll: { challenges: [] } } });
        // nothing published yet for a phase that overlays the timeout: a business request is not sent
        await expect(getBankroll('tok')).resolves.toBeNull();
        expect(axios).not.toHaveBeenCalled();

        await publishAs(7);
        await expect(getBankroll('tok')).resolves.toMatchObject({ keys: 0 });
        expect(axios.mock.calls.map(([config]) => config.timeout)).toEqual([12000]);
        expect(settings.getSetting('apiTimeout')).toBe(30);
    });

    test('a bankroll-derived phase that overlays the transport loads its evidence once, under the saved policy, without recursion', async () => {
        select('android-service');
        axios.mockResolvedValue({
            status: 200,
            headers: {},
            data: { success: true, bankroll: { challenges: [{ type: 'KEYS', amount: 6 }] } },
        });
        // the owner's own evidence read, through the real endpoint, while the phase overlaying the timeout is unpublished
        const status = await publishInstallationOverlay({
            token: 'tok',
            ledger: scenarioStateLedger,
            reads: { getBankroll },
        });
        expect(status).toBe('published');
        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios.mock.calls[0][0].timeout).toBe(30000);
        expect(record().published).toMatchObject({ bindings: { currencyReserveKeys: 6 } });
        // and the next business request runs under the published 12 s
        await getBankroll('tok');
        expect(axios.mock.calls[1][0].timeout).toBe(12000);
    });

    test('a spend keeps its single send under a published policy with retries', async () => {
        select('android-service', accountPlan({ settings: { apiMaxRetries: 4, apiTimeout: 12 }, bindings: {} }));
        await publishAs();
        const { postOnce, createCommonHeaders } =
            require('../../src/ts/core/api/api-client') as typeof import('../../src/ts/core/api/api-client');
        const failure = Object.assign(new Error('Request failed with status code 503'), {
            response: { status: 503, data: {}, headers: {} },
        });
        axios.mockRejectedValue(failure);
        await expect(postOnce('https://example.test/spend', createCommonHeaders('tok'), '')).resolves.toEqual({
            kind: 'unclear',
        });
        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios.mock.calls[0][0].timeout).toBe(12000);
    });

    describe('what a read finds in a record that is not as the owner left it', () => {
        const literalsOnly = () => accountPlan({ bindings: undefined });
        const bindingsOnly = () => accountPlan({ settings: undefined });
        const edit = (change: (record: ScenarioState) => ScenarioState) =>
            expect(
                scenarioStateLedger.change(INSTALLATION, (current) => change(current as ScenarioState)),
            ).toMatchObject({
                ok: true,
            });
        // The record is not one a ledger can read: written under it, then read in again as another process's write would be.
        const corrupt = async () => {
            // (the count of resets stays, or the reset asked for in beforeEach would be applied over the whole file)
            const file = parseJsonObject(store.keys.get('gs_scenario_state') as string);
            store.keys.set('gs_scenario_state', JSON.stringify({ ...file, [INSTALLATION]: { scenario: 5 } }));
            await refreshScenarioStateAsync();
        };
        const unavailable = (key: string, reason: string) => {
            expect(() => settings.getInstallationSetting(key)).toThrow(settings.ScenarioSettingUnavailableError);
            expect(settings.readInstallationSetting(key)).toMatchObject({
                state: 'unknown',
                reason: expect.stringContaining(reason),
            });
        };

        test('a phase of literals alone, and one of bindings alone, are published and read', async () => {
            select('android-service', literalsOnly());
            await expect(publishAs()).resolves.toBe('published');
            expect(record().published?.bindings).toEqual({});
            expect(settings.getInstallationSetting('apiTimeout')).toBe(12);
            expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(0);

            save(bindingsOnly());
            await expect(publishAs(4)).resolves.toBe('published');
            expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(4);
            expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        });

        test('a malformed publication is unavailable, and the rest of the record is intact', async () => {
            select();
            await publishAs();
            edit((held) => ({ ...held, published: invalid<ScenarioState['published']>({ unexpected: true }) }));
            unavailable('apiTimeout', 'malformed');
            expect(record().publicationUnreadable).toBe(true);
            expect(record().scenario).toBe('Account plan');
        });

        test('a publication from another visit to the phase is unavailable', async () => {
            select();
            await publishAs();
            edit((held) => ({ ...held, phaseEnteredAt: held.phaseEnteredAt + 10 }));
            unavailable('apiTimeout', 'earlier visit');
        });

        test.each([
            [
                'a binding is missing from it',
                (bindings: Record<string, unknown>) => ({ ...bindings, currencyReserveKeys: undefined }),
            ],
            ['another binding stands in its place', () => ({ other: 1 })],
            ['an extra binding is in it', (bindings: Record<string, unknown>) => ({ ...bindings, extra: 1 })],
        ])("a publication whose bindings do not match the phase's: %s", async (_name, rewrite) => {
            select();
            await publishAs();
            edit((held) => {
                const published = held.published as NonNullable<ScenarioState['published']>;
                const bindings = Object.fromEntries(
                    Object.entries(rewrite(published.bindings)).filter(([, value]) => value !== undefined),
                );
                return { ...held, published: { ...published, bindings } };
            });
            unavailable('apiTimeout', 'do not match');
        });

        test("a publication that names no generation is not the owner's of this one", async () => {
            select();
            await publishAs();
            edit((held) => {
                const published = { ...(held.published as NonNullable<ScenarioState['published']>) };
                delete published.generation;
                return { ...held, published };
            });
            unavailable('apiTimeout', 'another owner');
        });

        test("a record without a generation is read at the assignment's own (the later of the two is current)", async () => {
            select();
            await publishAs();
            edit((held) => {
                const rest = { ...held };
                delete rest.generation;
                return rest;
            });
            expect(settings.getInstallationSetting('apiTimeout')).toBe(12);
        });

        test("a record of another scenario, or none, expects the start phase's settings: unavailable until published", async () => {
            select();
            await publishAs();
            edit((held) => ({ ...held, scenario: 'Another plan' }));
            unavailable('apiTimeout', 'nothing is published');
            await scenarioStateLedger.removeAll();
            unavailable('apiTimeout', 'nothing is published');
        });

        test('a phase the scenario no longer has overlays nothing', async () => {
            select();
            await publishAs();
            edit((held) => ({ ...held, phase: 'gone' }));
            expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        });

        test('a record that cannot be read leaves the keys any phase sets unavailable, and the others as saved', async () => {
            select();
            await corrupt();
            unavailable('apiTimeout', 'cannot be read');
            unavailable('currencyReserveKeys', 'cannot be read');
            expect(settings.getInstallationSetting('apiMaxRetries')).toBe(3);
        });

        test('a record that cannot be read costs nothing when no phase sets a key', async () => {
            select('android-service', accountPlan({ settings: undefined, bindings: undefined }));
            await corrupt();
            expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
        });

        test('an assignment to a scenario that is gone, or is a challenge scenario, overlays nothing', async () => {
            select();
            await publishAs();
            const name = (scenario: string) => {
                const next = parseJsonObject(store.value as string);
                store.value = JSON.stringify({
                    ...next,
                    installationScenario: {
                        ...parseJsonAs(JSON.stringify(next.installationScenario), isPlainObject),
                        scenario,
                    },
                });
            };
            name('Gone');
            expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
            expect(
                settings.saveScenario(
                    { name: 'Challenge plan', version: 1, start: 'a', phases: { a: {} } },
                    { expectedDefinitionRevision: settings.getScenarioLibrary().revision as number },
                ),
            ).toEqual({ ok: true, name: 'Challenge plan' });
            name('Challenge plan');
            expect(settings.getInstallationSetting('apiTimeout')).toBe(30);
            await expect(publishAs()).resolves.toBe('none');
        });
    });

    describe('what the facade prepares for the owner', () => {
        const plan = () => {
            const found = settings.getScenario('Account plan') as ScenarioDocument;
            return found;
        };
        const state = { phase: 'tune', phaseEnteredAt: NOW, published: undefined };
        const prepare = (
            bound: Record<string, ReturnType<typeof known>>,
            read?: (key: string, view: 'base' | 'effective') => unknown,
        ) =>
            settings.prepareInstallationSnapshot(
                plan(),
                state,
                (readBase) => {
                    read?.('', 'base');
                    void readBase;
                    return { bound: invalid(bound), validUntil: null };
                },
                1,
                NOW,
            );

        test('a binding that is absent or unknown refuses the whole phase, with the key and why', () => {
            select();
            expect(prepare({ currencyReserveKeys: invalid({ state: 'absent', reason: 'not-present' }) })).toEqual({
                ok: false,
                key: 'currencyReserveKeys',
                reason: 'absent: not-present',
            });
            expect(
                prepare({
                    currencyReserveKeys: invalid({ state: 'unknown', reason: 'balance-unreadable', dependencies: [] }),
                }),
            ).toEqual({
                ok: false,
                key: 'currencyReserveKeys',
                reason: 'balance-unreadable',
            });
        });

        test('a binding reads the saved value of a setting, and nothing of the overlay it is being made for', () => {
            select();
            const seen: unknown[] = [];
            settings.prepareInstallationSnapshot(
                plan(),
                state,
                (readBase) => {
                    seen.push(
                        readBase('apiTimeout', 'base'),
                        readBase('apiTimeout', 'effective'),
                        readBase('noSuchSetting', 'base'),
                    );
                    return {
                        bound: { currencyReserveKeys: known({ kind: 'number', value: 1, quantity: 'keys' }) },
                        validUntil: null,
                    };
                },
                1,
                NOW,
            );
            expect(seen).toMatchObject([
                { state: 'known', value: { value: 30 } },
                { state: 'unknown', reason: 'binding-reads-base-only' },
                { state: 'unknown', reason: 'setting-unknown' },
            ]);
        });

        test('a binding whose value does not fit its setting refuses the phase, with the key and why', () => {
            select();
            expect(prepare({ currencyReserveKeys: known({ kind: 'string', value: 'many' }) })).toEqual({
                ok: false,
                key: 'currencyReserveKeys',
                reason: 'type-mismatch',
            });
        });

        test('a setting no installation phase owns is read as saved', () => {
            expect(settings.getInstallationSetting('exposure')).toBe(settings.getGlobalDefault('exposure'));
        });
    });

    test('mock mode reads and publishes only the in-memory ledger', async () => {
        select('android-service');
        const { mockScenarioStateLedger } =
            require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
        expect(settings.setSetting('mock', true)).toBe(true);
        const real = store.keys.get('gs_scenario_state');
        // nothing is published in the mock ledger yet: the phase's settings are unavailable there
        expect(() => settings.getInstallationSetting('apiTimeout')).toThrow(settings.ScenarioSettingUnavailableError);
        await expect(
            publishInstallationOverlay({ token: 'tok', ledger: mockScenarioStateLedger, reads: ownerReads(4) }),
        ).resolves.toBe('published');
        expect(settings.getInstallationSetting('currencyReserveKeys')).toBe(4);
        expect(store.keys.get('gs_scenario_state')).toBe(real);
        await mockScenarioStateLedger.removeAll();
    });
});
